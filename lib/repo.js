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
  STATUS,
  PROP_STATUS
} = require('./apply')
const Workspace = require('./workspace')
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

const WORKSPACES = 'hs/workspaces'

module.exports = class Repo extends ReadyResource {
  // fastForward: { boot: { head: { key, length } } } boots main from a writer's oplog head
  // (the view it stamps) instead of replaying every land: a new peer then only fetches the
  // tree blocks it reads, like Scion daemons starting from a snapshot
  constructor(store, { key = null, encryptionKey = null, fastForward = undefined } = {}) {
    super()

    this.store = store
    this.encryptionKey = encryptionKey
    this.main = new Autobee(store.namespace('main'), key, {
      apply,
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

  // changesets with from < seq <= to, oldest first
  async changesetsBetween(from, to, snapshot = this.main.view) {
    const out = []
    if (to <= from) return out
    for await (const node of snapshot.createReadStream(keys.csRange({ gt: from, lte: to }))) {
      out.push(c.decode(Changeset, node.value))
    }
    return out
  }

  // dedup: an existing landed entry with identical content, if any
  async lookupHash(hash) {
    const node = await this.main.view.get(keys.hash(hash))
    return node ? node.value : null
  }

  addWriter(key, { indexer = false, handle = null } = {}) {
    return this._append({ type: OP_ADD_WRITER, addWriter: { key, indexer, handle } })
  }

  propose(op) {
    return this._append({ type: OP_PROPOSE, propose: op })
  }

  review(op) {
    return this._append({ type: OP_REVIEW, review: op })
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

  async eventCount(snapshot = this.main.view) {
    const node = await snapshot.get(keys.meta)
    return node ? c.decode(Meta, node.value).events || 0 : 0
  }

  async policyText(snapshot = this.main.view) {
    const node = await snapshot.get(keys.policy)
    return node ? c.decode(Policy, node.value).text : ''
  }

  land(op) {
    return this._append({ type: OP_LAND, land: op })
  }

  async _append(op) {
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
