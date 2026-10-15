// The autobee apply function for main. It must be total: a bad or conflicting op is
// recorded as an outcome, never thrown, since a throw closes the db.
//
// Landing is lock-free optimistic concurrency at path granularity. A land carries the
// base it forked from ({seq, hash} of the last accepted changeset it saw) and inlined
// entries. It is accepted iff the base is still on main's hash chain and no landed path
// was touched by a changeset after the base.
const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const unixPathResolve = require('unix-path-resolve')
const driveEntry = require('hyperdrive/lib/encoding')
const { getEncoding } = require('./schema/spec')
const keys = require('./keys')
const rules = require('./rules')

const Op = getEncoding('@hs/op')
const Meta = getEncoding('@hs/meta')
const Changeset = getEncoding('@hs/changeset')
const Outcome = getEncoding('@hs/outcome')
const PathRecord = getEncoding('@hs/path')
const Hist = getEncoding('@hs/hist')
const Writer = getEncoding('@hs/writer')
const Proposal = getEncoding('@hs/proposal')
const ReviewRecord = getEncoding('@hs/review-record')
const Request = getEncoding('@hs/request')
const Event = getEncoding('@hs/event')
const Policy = getEncoding('@hs/policy')

const OP_LAND = 1
const OP_ADD_WRITER = 2
const OP_PROPOSE = 3
const OP_REVIEW = 4
const OP_ACK = 5

const ACCEPTED = 0
const CONFLICT = 1
const STALE_BASE = 2
const INVALID = 3
const NEEDS_REVIEW = 4
const STALE_REVIEW = 5

const STATUS = ['accepted', 'conflict', 'stale-base', 'invalid', 'needs-review', 'stale-review']

const APPROVE = 1
const CHANGES = 2
const COMMENT = 3
const VERDICTS = [null, 'approve', 'changes', 'comment']

const PROP_OPEN = 0
const PROP_APPROVED = 1
const PROP_LANDED = 2
const PROP_STATUS = ['open', 'approved', 'landed']

const POLICY_PATH = '/.hsreview'
const MAX_QUORUM = 64

const MAX_CONFLICTS_REPORTED = 64
const FILES_LISTED = 100

// opts.bootstrap: main's bootstrap writer key, always an indexer
async function apply(nodes, view, host, opts = {}) {
  const tx = new Overlay(view)
  tx.bootstrap = opts.bootstrap || null

  for (const node of nodes) {
    let op = null
    try {
      op = c.decode(Op, node.value)
    } catch {
      await tx.outcome(node, { status: INVALID, reason: 'undecodable op' })
      continue
    }

    await recordSeen(tx, node, op.seen)

    if (op.type === OP_LAND && op.land) await land(tx, node, op.land)
    else if (op.type === OP_ADD_WRITER && op.addWriter) {
      await addWriter(tx, node, op.addWriter, host)
    } else if (op.type === OP_PROPOSE && op.propose) {
      await propose(tx, node, op.propose)
    } else if (op.type === OP_REVIEW && op.review) {
      await review(tx, node, op.review)
    } else if (op.type === OP_ACK) {
      tx.outcome(node, { status: ACCEPTED })
    } else {
      await tx.outcome(node, { status: INVALID, reason: 'unknown op type' })
    }

    await advanceSettled(tx, node)
  }

  await tx.flush()
}

// A writer's op says which changeset it had seen. Only markers that match main's chain count,
// so after a reorg changes #n, old claims about #n stop counting.
async function recordSeen(tx, node, seen) {
  if (!seen || !seen.hash) return
  const meta = await tx.meta()
  if (seen.seq > meta.seq) return
  const expected = seen.seq === 0 ? keys.ZERO : await tx.changesetHash(seen.seq)
  if (!expected || !b4a.equals(expected, seen.hash)) return
  if (seen.seq <= (await tx.seenBy(node.key))) return
  tx.put(keys.seen(node.key), c.encode(PathRecord, { seq: seen.seq }))
}

// Settled: every changeset up to the lowest point all indexers have seen. Indexers carry the
// heaviest weight in autobee's ordering, so a node they have all built on is ordered ahead of
// anything they haven't seen and can no longer be reordered (see DESIGN.md, finality).
async function advanceSettled(tx, node) {
  const indexers = await tx.indexers()
  if (!indexers.length) return
  let settled = Infinity
  for (const key of indexers) settled = Math.min(settled, await tx.seenBy(key))
  const meta = await tx.meta()
  settled = Math.min(settled, meta.seq)
  if (settled <= (meta.settled || 0)) return
  tx.setMeta({ ...meta, settled })
  await tx.event({ type: 'settled', actor: node.key, seq: settled })
}

// the base must be on main's chain; after a reorg a fork point can disappear
async function checkBase(tx, base) {
  const meta = await tx.meta()
  if (base.seq > meta.seq) return 'unknown base'
  const expected = base.seq === 0 ? keys.ZERO : await tx.changesetHash(base.seq)
  if (expected === null || !b4a.equals(expected, base.hash)) return 'base not on main'
  return null
}

// validated entries, or { reason }
function collectEntries(op) {
  const entries = []
  const seen = new Set()
  // optional arrays decode as null when absent
  for (const e of op.entries || []) {
    const reason = validateEntry(e, seen)
    if (reason) return { reason }
    entries.push(e)
  }
  if (entries.length === 0) return { reason: 'empty' }
  return { entries }
}

// A change to /.hsreview must carry the file's text inline, matching the entry's content hash,
// so apply can enforce review policy without fetching blobs. Returns { text } (null when the
// policy file is untouched, '' when deleted) or { reason }.
function policyChange(entries, text) {
  const e = entries.find((x) => x.path === POLICY_PATH)
  if (!e) return { text: null }
  if (!e.value) return { text: '' }
  // an empty text encodes as absent; the content hash decides either way
  const t = typeof text === 'string' ? text : ''
  if (!e.decoded.hash || !b4a.equals(crypto.hash(b4a.from(t)), e.decoded.hash)) {
    return { reason: POLICY_PATH + ' changes must include its text, matching its content hash' }
  }
  return { text: t }
}

async function land(tx, node, op) {
  const meta = await tx.meta()
  const base = op.base

  const stale = await checkBase(tx, base)
  if (stale) return tx.outcome(node, { status: STALE_BASE, reason: stale })

  const collected = collectEntries(op)
  if (collected.reason) {
    const reason = collected.reason === 'empty' ? 'empty land' : collected.reason
    return tx.outcome(node, { status: INVALID, reason })
  }
  const entries = collected.entries

  const policy = policyChange(entries, op.policy)
  if (policy.reason) return tx.outcome(node, { status: INVALID, reason: policy.reason })

  const conflicts = []
  for (const e of entries) {
    const last = await tx.pathSeq(e.path)
    if (last > base.seq) {
      conflicts.push(e.path)
      if (conflicts.length === MAX_CONFLICTS_REPORTED) break
    }
  }

  if (conflicts.length) return tx.outcome(node, { status: CONFLICT, conflicts })

  // Ask: an approved proposal, landed by its author with exactly the approved content
  let prop = null
  if (op.proposal) {
    prop = await tx.proposal(op.proposal)
    if (!prop || !b4a.equals(prop.author, node.key)) {
      return tx.outcome(node, {
        status: INVALID,
        reason: 'no such proposal of yours: P' + op.proposal
      })
    }
    if (prop.status === PROP_LANDED) {
      return tx.outcome(node, { status: INVALID, reason: 'P' + prop.id + ' already landed' })
    }
    if (!b4a.equals(rules.contentHash(entries), prop.hash)) {
      return tx.outcome(node, {
        status: NEEDS_REVIEW,
        proposal: prop.id,
        reason: 'content changed since P' + prop.id + ' was reviewed: propose again'
      })
    }
    if (prop.status !== PROP_APPROVED) {
      return tx.outcome(node, {
        status: NEEDS_REVIEW,
        proposal: prop.id,
        reason: `P${prop.id} has ${prop.approvals || 0}/${prop.quorum || 1} approvals`
      })
    }
  }

  // opt-in policy from /.hsreview: protected paths only land through an approved proposal
  const req = rules.requirement(
    await tx.policyRules(),
    entries.map((e) => e.path)
  )
  if (req) {
    const approvers = prop ? await tx.approvers(prop) : []
    let reason = null
    if (!prop) {
      reason = `${req.paths.join(' ')} need${req.paths.length === 1 ? 's' : ''} ${req.approvals} approval(s) (${req.pattern} in ${POLICY_PATH}): propose it`
    } else if (approvers.length < req.approvals) {
      reason = `${req.pattern} needs ${req.approvals} approval(s), P${prop.id} has ${approvers.length}`
    } else if (req.reviewers.length) {
      const wanted = await tx.keysOf(req.reviewers)
      if (!approvers.some((k) => wanted.some((w) => b4a.equals(w, k)))) {
        reason = `${req.pattern} needs an approval from one of ${req.reviewers.join(', ')}`
      }
    }
    if (reason) {
      return tx.outcome(node, { status: NEEDS_REVIEW, reason, proposal: prop ? prop.id : 0 })
    }
  }

  const seq = meta.seq + 1
  const hash = crypto.hash([meta.hash, node.value])

  for (const e of entries) {
    // before/after values for `hs show` (one extra lookup per path)
    const prev = await tx.get(keys.files.encode(e.path))
    tx.put(keys.hist(e.path, seq), c.encode(Hist, { prev, next: e.value }))

    if (e.value) {
      tx.put(keys.files.encode(e.path), e.value)
      const h = e.decoded.hash
      if (h && !(await tx.has(keys.hash(h)))) tx.put(keys.hash(h), e.value)
    } else {
      tx.del(keys.files.encode(e.path))
    }
    tx.put(keys.path(e.path), c.encode(PathRecord, { seq }))
  }

  tx.put(
    keys.cs(seq),
    c.encode(Changeset, {
      seq,
      hash,
      writer: node.key,
      node: node.length,
      ws: op.ws,
      base,
      paths: entries.length,
      message: op.message,
      author: op.author,
      time: op.time,
      blobs: op.blobs,
      files: entries.slice(0, FILES_LISTED).map((e) => (e.value ? e.path : '-' + e.path)),
      proposal: prop ? prop.id : 0
    })
  )
  tx.setMeta({ ...meta, seq, hash })

  if (policy.text !== null) tx.put(keys.policy, c.encode(Policy, { text: policy.text }))

  if (prop) {
    tx.putProposal({ ...prop, status: PROP_LANDED, landed: seq })
    await tx.event({ type: 'landed', actor: node.key, proposal: prop.id, seq, time: op.time })
  }

  // Show: landed, and these teammates are asked to look at it
  const reviewers = (await tx.keysOf(op.reviewers || [])).filter((k) => !b4a.equals(k, node.key))
  if (reviewers.length) {
    tx.put(keys.request(seq), c.encode(Request, { author: node.key, reviewers }))
    await tx.event({ type: 'request', actor: node.key, seq, reviewers, time: op.time })
  }

  return tx.outcome(node, { status: ACCEPTED, seq })
}

async function addWriter(tx, node, op, host) {
  const handle = op.handle
  const prevBuf = await tx.get(keys.writer(op.key))
  const prev = prevBuf ? c.decode(Writer, prevBuf) : { handle: '', indexer: false }

  if (handle) {
    if (!rules.HANDLE.test(handle)) {
      return tx.outcome(node, { status: INVALID, reason: 'bad handle: ' + handle })
    }
    const owner = await tx.get(keys.handle(handle))
    if (owner && !b4a.equals(owner, op.key)) {
      return tx.outcome(node, { status: INVALID, reason: 'handle taken: ' + handle })
    }
    if (prev.handle && prev.handle !== handle) tx.del(keys.handle(prev.handle))
    tx.put(keys.handle(handle), op.key)
  }

  const record = { handle: handle || prev.handle || '', indexer: !!op.indexer || !!prev.indexer }
  tx.put(keys.writer(op.key), c.encode(Writer, record))
  host.addWriter(op.key, { isIndexer: record.indexer })
  return tx.outcome(node, { status: ACCEPTED })
}

async function propose(tx, node, op) {
  const stale = await checkBase(tx, op.base)
  if (stale) return tx.outcome(node, { status: STALE_BASE, reason: stale })

  const collected = collectEntries(op)
  if (collected.reason) {
    const reason = collected.reason === 'empty' ? 'empty proposal' : collected.reason
    return tx.outcome(node, { status: INVALID, reason })
  }
  const entries = collected.entries

  const policy = policyChange(entries, op.policy)
  if (policy.reason) return tx.outcome(node, { status: INVALID, reason: policy.reason })

  const handles = op.reviewers || []
  const reviewerKeys = await tx.keysOf(handles)
  if (reviewerKeys.length !== handles.length) {
    return tx.outcome(node, { status: INVALID, reason: 'unknown reviewer in ' + handles.join(',') })
  }

  let prop = null
  let type = 'proposal'
  if (op.replaces) {
    prop = await tx.proposal(op.replaces)
    if (!prop || !b4a.equals(prop.author, node.key) || prop.status === PROP_LANDED) {
      return tx.outcome(node, { status: INVALID, reason: 'cannot update P' + op.replaces })
    }
    type = 'proposal-updated'
  } else {
    const meta = await tx.meta()
    const id = (meta.proposals || 0) + 1
    tx.setMeta({ ...meta, proposals: id })
    prop = { id, author: node.key, revision: 0, quorum: 1, reviewers: [] }
  }

  prop = {
    ...prop,
    ws: op.ws,
    base: op.base,
    entries: entries.map((e) => ({ path: e.path, value: e.value || null })),
    hash: rules.contentHash(entries),
    message: op.message,
    time: op.time,
    blobs: op.blobs,
    reviewers:
      handles.length || !op.replaces
        ? reviewerKeys.filter((k) => !b4a.equals(k, node.key))
        : prop.reviewers,
    quorum: Math.max(1, Math.min(op.quorum || prop.quorum || 1, MAX_QUORUM)),
    revision: op.replaces ? (prop.revision || 0) + 1 : 0,
    status: PROP_OPEN,
    approvals: 0,
    landed: 0,
    policy: policy.text === null ? null : policy.text
  }
  tx.putProposal(prop)
  await tx.event({
    type,
    actor: node.key,
    proposal: prop.id,
    reviewers: prop.reviewers,
    time: op.time
  })

  return tx.outcome(node, { status: ACCEPTED, proposal: prop.id })
}

async function review(tx, node, op) {
  if (!VERDICTS[op.verdict]) return tx.outcome(node, { status: INVALID, reason: 'bad verdict' })
  const record = {
    writer: node.key,
    verdict: op.verdict,
    hash: op.hash || null,
    comment: op.comment,
    time: op.time
  }

  if (op.proposal) {
    const prop = await tx.proposal(op.proposal)
    if (!prop) {
      return tx.outcome(node, { status: INVALID, reason: 'no such proposal P' + op.proposal })
    }
    // approvals and change requests are pinned to the content they reviewed
    if (op.verdict !== COMMENT && (!op.hash || !b4a.equals(op.hash, prop.hash))) {
      return tx.outcome(node, {
        status: STALE_REVIEW,
        proposal: prop.id,
        reason: `P${prop.id} changed (revision ${prop.revision}) since you looked; review it again`
      })
    }
    tx.put(keys.review(keys.TARGET_PROPOSAL, prop.id, node.key), c.encode(ReviewRecord, record))
    await tx.event({
      type: 'review',
      actor: node.key,
      proposal: prop.id,
      verdict: op.verdict,
      comment: op.comment,
      time: op.time
    })

    if (prop.status !== PROP_LANDED) {
      const approvals = (await tx.approvers(prop)).length
      const quorum = prop.quorum || 1
      const status = approvals >= quorum ? PROP_APPROVED : PROP_OPEN
      if (status === PROP_APPROVED && prop.status !== PROP_APPROVED) {
        await tx.event({ type: 'approved', actor: node.key, proposal: prop.id, time: op.time })
      }
      tx.putProposal({ ...prop, approvals, status })
    }
    return tx.outcome(node, { status: ACCEPTED, proposal: prop.id })
  }

  if (op.seq) {
    if (!(await tx.has(keys.cs(op.seq)))) {
      return tx.outcome(node, { status: INVALID, reason: 'no such changeset #' + op.seq })
    }
    tx.put(keys.review(keys.TARGET_CHANGESET, op.seq, node.key), c.encode(ReviewRecord, record))
    await tx.event({
      type: 'review',
      actor: node.key,
      seq: op.seq,
      verdict: op.verdict,
      comment: op.comment,
      time: op.time
    })
    return tx.outcome(node, { status: ACCEPTED, seq: op.seq })
  }

  return tx.outcome(node, { status: INVALID, reason: 'review needs a proposal or a changeset' })
}

function validateEntry(e, seen) {
  const p = e.path
  if (typeof p !== 'string' || p.length === 0 || p === '/') return 'bad path'
  if (unixPathResolve('/', p) !== p) return 'path not normalized: ' + p
  if (seen.has(p)) return 'duplicate path: ' + p
  seen.add(p)

  if (!e.value) return null

  try {
    e.decoded = c.decode(driveEntry, e.value)
  } catch {
    return 'undecodable entry: ' + p
  }

  // main has no blobs core of its own, every blob must say where it lives
  if (e.decoded.blob && !e.decoded.blob.core) return 'blob without core: ' + p
  return null
}

// Read-your-writes overlay so several ops in one apply batch see each other,
// flushed as a single hyperbee2 batch.
class Overlay {
  constructor(view) {
    this.view = view
    this.pending = new Map()
    this._meta = null
  }

  async get(key) {
    const hex = b4a.toString(key, 'hex')
    if (this.pending.has(hex)) return this.pending.get(hex).value
    const node = await this.view.get(key)
    return node ? node.value : null
  }

  async has(key) {
    return (await this.get(key)) !== null
  }

  put(key, value) {
    this.pending.set(b4a.toString(key, 'hex'), { key, value })
  }

  del(key) {
    this.pending.set(b4a.toString(key, 'hex'), { key, value: null })
  }

  async meta() {
    if (this._meta) return this._meta
    const buf = await this.get(keys.meta)
    this._meta = buf ? c.decode(Meta, buf) : { seq: 0, hash: keys.ZERO, proposals: 0, events: 0 }
    return this._meta
  }

  // range read that also sees this batch's pending writes
  async scan(range) {
    const out = new Map()
    for await (const node of this.view.createReadStream(range)) {
      out.set(b4a.toString(node.key, 'hex'), { key: node.key, value: node.value })
    }
    for (const [hex, entry] of this.pending) {
      const k = entry.key
      if (range.gte && b4a.compare(k, range.gte) < 0) continue
      if (range.gt && b4a.compare(k, range.gt) <= 0) continue
      if (range.lt && b4a.compare(k, range.lt) >= 0) continue
      if (range.lte && b4a.compare(k, range.lte) > 0) continue
      if (entry.value === null) out.delete(hex)
      else out.set(hex, entry)
    }
    return [...out.values()].sort((a, b) => b4a.compare(a.key, b.key))
  }

  async proposal(id) {
    const buf = await this.get(keys.prop(id))
    return buf ? c.decode(Proposal, buf) : null
  }

  putProposal(prop) {
    this.put(keys.prop(prop.id), c.encode(Proposal, prop))
  }

  // distinct non-author writers whose latest review approves the proposal's current content
  async approvers(prop) {
    const out = []
    for (const { value } of await this.scan(keys.reviewRange(keys.TARGET_PROPOSAL, prop.id))) {
      const r = c.decode(ReviewRecord, value)
      if (r.verdict !== APPROVE || !r.hash || !b4a.equals(r.hash, prop.hash)) continue
      if (b4a.equals(r.writer, prop.author)) continue
      out.push(r.writer)
    }
    return out
  }

  // writer keys for handles; unknown handles are skipped
  async keysOf(handles) {
    const out = []
    for (const h of handles) {
      if (typeof h !== 'string' || !rules.HANDLE.test(h)) continue
      const key = await this.get(keys.handle(h))
      if (key && !out.some((k) => b4a.equals(k, key))) out.push(key)
    }
    return out
  }

  async seenBy(key) {
    const buf = await this.get(keys.seen(key))
    return buf ? c.decode(PathRecord, buf).seq : 0
  }

  // the bootstrap writer plus writers added as indexers
  async indexers() {
    const out = this.bootstrap ? [this.bootstrap] : []
    for (const { key, value } of await this.scan(keys.writerRange())) {
      const w = c.decode(Writer, value)
      const k = keys.writerKeyOf(key)
      if (w.indexer && !out.some((x) => b4a.equals(x, k))) out.push(k)
    }
    return out
  }

  async policyRules() {
    const buf = await this.get(keys.policy)
    return buf ? rules.parseReview(c.decode(Policy, buf).text) : []
  }

  async event(fields) {
    const meta = await this.meta()
    const n = (meta.events || 0) + 1
    this.setMeta({ ...meta, events: n })
    this.put(keys.event(n), c.encode(Event, { n, ...fields }))
  }

  setMeta(m) {
    this._meta = m
    this.put(keys.meta, c.encode(Meta, m))
  }

  async changesetHash(seq) {
    const buf = await this.get(keys.cs(seq))
    return buf ? c.decode(Changeset, buf).hash : null
  }

  async pathSeq(p) {
    const buf = await this.get(keys.path(p))
    return buf ? c.decode(PathRecord, buf).seq : 0
  }

  outcome(node, o) {
    this.put(keys.op(node.key, node.length), c.encode(Outcome, o))
  }

  async flush() {
    if (this.pending.size === 0) return
    const w = this.view.write()
    for (const { key, value } of this.pending.values()) {
      if (value === null) w.tryDelete(key)
      else w.tryPut(key, value)
    }
    await w.flush()
    this.pending.clear()
  }
}

module.exports = {
  apply,
  OP_LAND,
  OP_ADD_WRITER,
  OP_PROPOSE,
  OP_REVIEW,
  OP_ACK,
  ACCEPTED,
  CONFLICT,
  STALE_BASE,
  INVALID,
  NEEDS_REVIEW,
  STALE_REVIEW,
  STATUS,
  APPROVE,
  CHANGES,
  COMMENT,
  VERDICTS,
  PROP_OPEN,
  PROP_APPROVED,
  PROP_LANDED,
  PROP_STATUS,
  POLICY_PATH
}
