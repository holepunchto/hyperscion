const ReadyResource = require('ready-resource')
const Autobee = require('autobee')
const Hyperdrive = require('hyperdrive')
const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { getEncoding } = require('./schema/spec')
const {
  apply,
  OP_LAND,
  OP_ADD_WRITER,
  OP_PROPOSE,
  OP_REVIEW,
  OP_ACK,
  OP_REMOVE_WRITER,
  OP_ITEM,
  STATUS,
  PROP_STATUS
} = require('./apply')
const Workspace = require('./workspace')
const settle = require('./settle')
const keys = require('./keys')

const Op = getEncoding('@hs/op')
const Meta = getEncoding('@hs/meta')
const Changeset = getEncoding('@hs/changeset')
const Outcome = getEncoding('@hs/outcome')
const WorkspaceState = getEncoding('@hs/workspace')
const Hist = getEncoding('@hs/hist')
const PathRecord = getEncoding('@hs/path')
const Writer = getEncoding('@hs/writer')
const Proposal = getEncoding('@hs/proposal')
const ReviewRecord = getEncoding('@hs/review-record')
const Request = getEncoding('@hs/request')
const Event = getEncoding('@hs/event')
const Policy = getEncoding('@hs/policy')
const ItemOp = getEncoding('@hs/item-op')
const ItemRecord = getEncoding('@hs/item')

const WORKSPACES = 'hs/workspaces'

module.exports = class Repo extends ReadyResource {
  // fastForward: { boot: { head: { key, length } } } boots main from a writer's oplog head
  // (the view it stamps) instead of replaying every land: a new peer then only fetches the
  // tree blocks it reads, like Scion daemons starting from a snapshot
  // bootstrapWeight: 2 (repos before milestone 7) makes the bootstrap writer an indexer for
  // good; 1 (new repos) makes it a plain writer, so a hub can be a separate, removable
  // indexer. Every peer of a repo must use the same value (it is in the invite).
  constructor(
    store,
    { key = null, encryptionKey = null, fastForward = undefined, bootstrapWeight = 2 } = {}
  ) {
    super()

    this.store = store
    this.encryptionKey = encryptionKey
    this.lightBootstrap = bootstrapWeight === 1
    this.main = new Autobee(store.namespace('main'), key, {
      apply: (nodes, view, host) =>
        apply(nodes, view, host, {
          bootstrap: this.main.key,
          lightBootstrap: this.lightBootstrap
        }),
      bootstrapWeight,
      optimistic: false,
      encryptionKey,
      encrypted: !!encryptionKey,
      fastForward
    })
    this.workspaces = new Map()
  }

  async _open() {
    await this.main.ready()
  }

  async _close() {
    for (const ws of this.workspaces.values()) await ws.close()
    await this.main.close()
  }

  get key() {
    return this.main.key
  }

  get discoveryKey() {
    return this.main.discoveryKey
  }

  get writable() {
    return this.main.writable
  }

  get writerKey() {
    return this.main.local.key
  }

  // encryption provider for every core a hyperbee2 tree traverses (view + workspaces)
  getEncryption() {
    return this.encryptionKey ? this.main.getViewEncryption() : null
  }

  replicate(...args) {
    return this.store.replicate(...args)
  }

  async update() {
    await this.main.update()
  }

  // a stable read snapshot of main's tree
  snapshot() {
    return this.main.view.snapshot()
  }

  head() {
    return this.main.view.head()
  }

  // read-only drive over main (or a snapshot of it). Every entry references its blobs core.
  drive(snapshot = this.snapshot()) {
    return new Hyperdrive(this.store.session(), {
      _db: snapshot,
      blobs: false,
      encryption: this.getEncryption()
    })
  }

  async meta(snapshot = this.main.view) {
    const node = await snapshot.get(keys.meta)
    return node ? c.decode(Meta, node.value) : { seq: 0, hash: keys.ZERO }
  }

  async changeset(seq, snapshot = this.main.view) {
    const node = await snapshot.get(keys.cs(seq))
    return node ? c.decode(Changeset, node.value) : null
  }

  async outcome(node, snapshot = this.main.view) {
    const res = await snapshot.get(keys.op(node.key, node.length))
    if (!res) return null
    const o = c.decode(Outcome, res.value)
    return { ...o, status: STATUS[o.status] || 'unknown' }
  }

  async *log({ path = null, limit = Infinity } = {}) {
    const snap = this.snapshot()
    try {
      if (path === null) {
        const range = keys.csRange({ reverse: true, limit: limit === Infinity ? -1 : limit })
        for await (const node of snap.createReadStream(range)) yield c.decode(Changeset, node.value)
        return
      }

      let n = 0
      for await (const node of snap.createReadStream(keys.histRange(path))) {
        if (n++ >= limit) break
        yield await this.changeset(keys.histSeq(node.key), snap)
      }
    } finally {
      await snap.close()
    }
  }

  // A changeset with each listed file's entry before and after it (hyperdrive entry buffers).
  // Records written before hist values existed have prev/next undefined.
  async show(seq, snapshot = this.main.view) {
    const cs = await this.changeset(seq, snapshot)
    if (!cs) return null
    const files = []
    for (const f of cs.files || []) {
      const deleted = f.startsWith('-')
      const path = deleted ? f.slice(1) : f
      const node = await snapshot.get(keys.hist(path, seq))
      let rec = { prev: undefined, next: undefined }
      if (node && node.value.byteLength) rec = c.decode(Hist, node.value)
      files.push({ path, deleted, prev: rec.prev, next: rec.next })
    }
    return { cs, files, truncated: (cs.paths || 0) > files.length }
  }

  // the changeset that last touched a path (who to talk to about it)
  async lastChange(path, snapshot = this.main.view) {
    const node = await snapshot.get(keys.path(path))
    if (!node) return null
    return this.changeset(c.decode(PathRecord, node.value).seq, snapshot)
  }

  // the changeset a writer's oplog node landed as, if it's on main: after a reorg the same
  // land can sit under another number. Scans the latest `window` changesets
  async changesetAt(writer, node, { window = 256 } = {}, snapshot = this.main.view) {
    const meta = await this.meta(snapshot)
    for (const cs of await this.changesetsBetween(
      Math.max(0, meta.seq - window),
      meta.seq,
      snapshot
    )) {
      if (cs.node === node && b4a.equals(cs.writer, writer)) return cs
    }
    return null
  }

  // changesets with from < seq <= to, oldest first
  async changesetsBetween(from, to, snapshot = this.main.view) {
    const out = []
    if (to <= from) return out
    for await (const node of snapshot.createReadStream(keys.csRange({ gt: from, lte: to }))) {
      out.push(c.decode(Changeset, node.value))
    }
    return out
  }

  // one path's entry as it was right after #seq (null if absent then), from path history
  async entryAt(path, seq, snapshot = this.main.view) {
    for await (const node of snapshot.createReadStream(keys.histRange(path))) {
      if (keys.histSeq(node.key) > seq) continue
      const rec = node.value.byteLength ? c.decode(Hist, node.value) : {}
      return rec.next || null
    }
    return null
  }

  // main's tree as it was right after #seq: [{ path, value }] (hyperdrive entry buffers),
  // rebuilt from path history, so changesets landed before hist values existed are missing
  async treeAt(seq, snapshot = this.main.view) {
    const tree = new Map()
    for await (const node of snapshot.createReadStream(keys.histAll())) {
      if (keys.histSeq(node.key) > seq) continue
      const rec = node.value.byteLength ? c.decode(Hist, node.value) : {}
      tree.set(keys.histPath(node.key), rec.next) // ascending seq per path: the last one wins
    }
    const out = []
    for (const [path, value] of tree) if (value) out.push({ path, value })
    return out
  }

  // dedup: an existing landed entry with identical content, if any
  async lookupHash(hash) {
    const node = await this.main.view.get(keys.hash(hash))
    return node ? node.value : null
  }

  addWriter(key, { indexer = false, handle = null, human = false, owner = false } = {}) {
    return this._append({ type: OP_ADD_WRITER, addWriter: { key, indexer, handle, human, owner } })
  }

  propose(op) {
    return this._append({ type: OP_PROPOSE, propose: op })
  }

  // how many writers' view cores this peer doesn't hold in full (reads of main may then need
  // the network)
  // main's own view core with blocks it doesn't hold locally: read without touching the tree
  // (listing the view's cores reads it, and waits when exactly this is missing)
  viewCoreGap() {
    const core = this.main.view.core
    return core && core.contiguousLength < core.length ? core.length - core.contiguousLength : 0
  }

  async viewGaps() {
    let gaps = 0
    for (const key of await this.main.view.cores({ local: false })) {
      const core = this.store.get({ key, encryption: this.getEncryption() })
      try {
        await core.ready()
        if (core.contiguousLength < core.length) gaps++
      } finally {
        await core.close()
      }
    }
    return gaps
  }

  // --- items and claims (docs/TASKS.md) ----------------------------------------------------

  // record an item op (new, claim, release, take, drop): the payload's writer must be ours
  itemOp(payload) {
    return this._append({ type: OP_ITEM, item: { ...payload, writer: this.writerKey } })
  }

  async item(id, snapshot = this.main.view) {
    const node = await snapshot.get(keys.item(id))
    return node ? c.decode(ItemRecord, node.value) : null
  }

  async items(snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.itemRange())) {
      out.push(c.decode(ItemRecord, node.value))
    }
    return out
  }

  // each writer's latest recorded claim action, on one item or on all
  async claimRecords(item = null, snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.claimRange(item))) {
      out.push(c.decode(ItemOp, node.value))
    }
    return out
  }

  // an item by a unique id prefix (hex or the short form `hs` prints), or null
  async itemByPrefix(prefix, snapshot = this.main.view) {
    const p = String(prefix).replace(/^T/i, '').toLowerCase()
    const matches = (await this.items(snapshot)).filter((it) =>
      b4a.toString(it.id, 'hex').startsWith(p)
    )
    return matches.length === 1 ? matches[0] : null
  }

  review(op) {
    return this._append({ type: OP_REVIEW, review: op })
  }

  // tell everyone how far we've seen (indexers do this so lands settle)
  ack() {
    return this._append({ type: OP_ACK })
  }

  // --- identity -------------------------------------------------------------------------

  async handleOf(key, snapshot = this.main.view) {
    const node = await snapshot.get(keys.writer(key))
    return node ? c.decode(Writer, node.value).handle : null
  }

  async keyOf(handle, snapshot = this.main.view) {
    const node = await snapshot.get(keys.handle(handle))
    return node ? node.value : null
  }

  // display name for a writer key: its handle, else a short key
  async nameOf(key, snapshot = this.main.view) {
    return (await this.handleOf(key, snapshot)) || require('z32').encode(key).slice(0, 8)
  }

  // --- review ---------------------------------------------------------------------------

  async proposal(id, snapshot = this.main.view) {
    const node = await snapshot.get(keys.prop(id))
    if (!node) return null
    const p = c.decode(Proposal, node.value)
    return { ...p, statusName: PROP_STATUS[p.status || 0] }
  }

  async proposals(snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.propRange())) {
      const p = c.decode(Proposal, node.value)
      out.push({ ...p, statusName: PROP_STATUS[p.status || 0] })
    }
    return out
  }

  // latest review per reviewer of a proposal (kind TARGET_PROPOSAL) or changeset
  async reviews(kind, id, snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.reviewRange(kind, id))) {
      out.push(c.decode(ReviewRecord, node.value))
    }
    return out
  }

  // Show requests: [{ seq, author, reviewers }]
  async requests(snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.requestRange())) {
      out.push({ seq: keys.requestSeq(node.key), ...c.decode(Request, node.value) })
    }
    return out
  }

  async events({ since = 0, limit } = {}, snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.eventRange({ gt: since, limit }))) {
      out.push(c.decode(Event, node.value))
    }
    return out
  }

  async eventCount(snapshot = this.main.view, opts) {
    const node = await snapshot.get(keys.meta, opts)
    return node ? c.decode(Meta, node.value).events || 0 : 0
  }

  // --- settlement and finality ------------------------------------------------------------

  async seenBy(key, snapshot = this.main.view) {
    const node = await snapshot.get(keys.seen(key))
    return node ? c.decode(PathRecord, node.value).seq : 0
  }

  // the bootstrap writer plus writers added as indexers (same rule as apply)
  async indexers(snapshot = this.main.view) {
    const out = []
    let bootstrapRemoved = false
    for await (const node of snapshot.createReadStream(keys.writerRange())) {
      const w = c.decode(Writer, node.value)
      const k = keys.writerKeyOf(node.key)
      if (b4a.equals(k, this.main.key) && w.removed) bootstrapRemoved = true
      if (w.indexer && !w.removed && !out.some((x) => b4a.equals(x, k))) out.push(k)
    }
    if (
      !this.lightBootstrap &&
      !bootstrapRemoved &&
      !out.some((x) => b4a.equals(x, this.main.key))
    ) {
      out.unshift(this.main.key)
    }
    return out
  }

  // whose acks settlement waits for: the indexers that outweigh every other writer, or every
  // writer when none does (lib/settle.js, same rule as apply)
  async settlers(snapshot = this.main.view) {
    const writers = []
    for await (const node of snapshot.createReadStream(keys.writerRange())) {
      writers.push({ key: keys.writerKeyOf(node.key), value: c.decode(Writer, node.value) })
    }
    return settle.settlers(writers, {
      bootstrap: this.main.key,
      lightBootstrap: this.lightBootstrap
    })
  }

  // take a writer out (see apply: removeWriter); refuses the last indexer
  removeWriter(key) {
    return this._append({ type: OP_REMOVE_WRITER, removeWriter: { key } })
  }

  // a writer's record: { handle, indexer, removed }, or null
  async writer(key, snapshot = this.main.view) {
    const node = await snapshot.get(keys.writer(key))
    return node ? c.decode(Writer, node.value) : null
  }

  // every writer's key, removed ones included (their oplogs are still history), and the
  // bootstrap writer's
  async writerKeys(snapshot = this.main.view) {
    const out = [this.main.key]
    for await (const node of snapshot.createReadStream(keys.writerRange())) {
      const k = keys.writerKeyOf(node.key)
      if (!out.some((x) => b4a.equals(x, k))) out.push(k)
    }
    return out
  }

  // writers marked human (phase 2), for @humans
  async humans(snapshot = this.main.view) {
    const out = []
    for await (const node of snapshot.createReadStream(keys.writerRange())) {
      const w = c.decode(Writer, node.value)
      if (w.human && !w.removed) out.push(keys.writerKeyOf(node.key))
    }
    return out
  }

  async writerCount(snapshot = this.main.view) {
    let n = 0
    for await (const node of snapshot.createReadStream(keys.writerRange())) {
      if (!c.decode(Writer, node.value).removed) n++
    }
    return n
  }

  async settledSeq(snapshot = this.main.view) {
    return (await this.meta(snapshot)).settled || 0
  }

  async request(seq, snapshot = this.main.view) {
    const node = await snapshot.get(keys.request(seq))
    return node ? c.decode(Request, node.value) : null
  }

  // Where a land stands: settled (no concurrent land can reorder it) and accepted (wanted: a
  // Show land approved by a requested reviewer, an Ask land approved before landing, a Ship
  // land always). final = both. `waiting` says what it's waiting for.
  async landStatus(seq, snapshot = this.main.view) {
    const cs = await this.changeset(seq, snapshot)
    if (!cs) return null
    const settled = seq <= (await this.settledSeq(snapshot))
    const waiting = []

    if (!settled) {
      const behind = []
      for (const k of await this.settlers(snapshot)) {
        if ((await this.seenBy(k, snapshot)) < seq) behind.push(await this.nameOf(k, snapshot))
      }
      waiting.push(`${behind.join(', ') || 'indexers'} to ack`)
    }

    let accepted = true
    let kind = 'ship'
    if (cs.proposal) {
      kind = 'ask'
    } else {
      const req = await this.request(seq, snapshot)
      if (req) {
        kind = 'show'
        const reviews = (await this.reviews(keys.TARGET_CHANGESET, seq, snapshot)).filter((r) =>
          req.reviewers.some((k) => b4a.equals(k, r.writer))
        )
        const changes = reviews.filter((r) => r.verdict === 2)
        if (changes.length) {
          accepted = false
          waiting.push(
            `changes requested by ${(await Promise.all(changes.map((r) => this.nameOf(r.writer, snapshot)))).join(', ')}`
          )
        } else if (!reviews.some((r) => r.verdict === 1)) {
          accepted = false
          waiting.push(
            `review from ${(await Promise.all(req.reviewers.map((k) => this.nameOf(k, snapshot)))).join(', ')}`
          )
        }
      }
    }

    const state = settled && accepted ? 'final' : settled ? 'settled' : 'provisional'
    return { seq, kind, settled, accepted, final: settled && accepted, state, waiting }
  }

  async policyText(snapshot = this.main.view) {
    const node = await snapshot.get(keys.policy)
    return node ? c.decode(Policy, node.value).text : ''
  }

  land(op) {
    return this._append({ type: OP_LAND, land: op })
  }

  async _append(op) {
    // every op says how far this writer had seen; apply uses it to settle lands
    const meta = await this.meta()
    op = { ...op, seen: { seq: meta.seq, hash: meta.hash } }
    await this.main.append(c.encode(Op, op))
    const node = { key: this.main.local.key, length: this.main.local.length }
    await this.main.update()
    return { node, outcome: await this.outcome(node) }
  }

  async workspace(name, { create = true } = {}) {
    if (this.workspaces.has(name)) return this.workspaces.get(name)

    const all = await this._workspaceIndex()
    const state = all[name] ? c.decode(WorkspaceState, b4a.from(all[name], 'hex')) : null

    if (!state && !create) return null

    const ws = new Workspace(this, name, state)
    await ws.ready()
    this.workspaces.set(name, ws)

    if (!state) await this._saveWorkspace(ws)
    return ws
  }

  async listWorkspaces() {
    return Object.keys(await this._workspaceIndex())
  }

  async _saveWorkspace(ws) {
    const all = await this._workspaceIndex()
    all[ws.name] = b4a.toString(c.encode(WorkspaceState, ws.state), 'hex')
    await this.main.local.setUserData(WORKSPACES, b4a.from(JSON.stringify(all)))
  }

  async _dropWorkspace(name) {
    const all = await this._workspaceIndex()
    delete all[name]
    await this.main.local.setUserData(WORKSPACES, b4a.from(JSON.stringify(all)))
    this.workspaces.delete(name)
  }

  async _workspaceIndex() {
    await this.main.local.ready()
    const buf = await this.main.local.getUserData(WORKSPACES)
    return buf ? JSON.parse(b4a.toString(buf)) : {}
  }

  static hash(buf) {
    return crypto.hash(buf)
  }
}
