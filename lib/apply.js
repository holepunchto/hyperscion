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

const Op = getEncoding('@hs/op')
const Meta = getEncoding('@hs/meta')
const Changeset = getEncoding('@hs/changeset')
const Outcome = getEncoding('@hs/outcome')
const PathRecord = getEncoding('@hs/path')

const OP_LAND = 1
const OP_ADD_WRITER = 2

const ACCEPTED = 0
const CONFLICT = 1
const STALE_BASE = 2
const INVALID = 3

const STATUS = ['accepted', 'conflict', 'stale-base', 'invalid']

const MAX_CONFLICTS_REPORTED = 64

async function apply(nodes, view, host) {
  const tx = new Overlay(view)

  for (const node of nodes) {
    let op = null
    try {
      op = c.decode(Op, node.value)
    } catch {
      await tx.outcome(node, { status: INVALID, reason: 'undecodable op' })
      continue
    }

    if (op.type === OP_LAND && op.land) await land(tx, node, op.land)
    else if (op.type === OP_ADD_WRITER && op.addWriter) {
      await addWriter(tx, node, op.addWriter, host)
    } else {
      await tx.outcome(node, { status: INVALID, reason: 'unknown op type' })
    }
  }

  await tx.flush()
}

async function land(tx, node, op) {
  const meta = await tx.meta()
  const base = op.base

  // the base must be on main's chain; after a reorg a fork point can disappear
  if (base.seq > meta.seq) return tx.outcome(node, { status: STALE_BASE, reason: 'unknown base' })

  const expected = base.seq === 0 ? keys.ZERO : await tx.changesetHash(base.seq)
  if (expected === null || !b4a.equals(expected, base.hash)) {
    return tx.outcome(node, { status: STALE_BASE, reason: 'base not on main' })
  }

  const entries = []
  const seen = new Set()

  // optional arrays decode as null when absent
  for (const e of op.entries || []) {
    const reason = validateEntry(e, seen)
    if (reason) return tx.outcome(node, { status: INVALID, reason })
    entries.push(e)
  }

  if (entries.length === 0) return tx.outcome(node, { status: INVALID, reason: 'empty land' })

  const conflicts = []
  for (const e of entries) {
    const last = await tx.pathSeq(e.path)
    if (last > base.seq) {
      conflicts.push(e.path)
      if (conflicts.length === MAX_CONFLICTS_REPORTED) break
    }
  }

  if (conflicts.length) return tx.outcome(node, { status: CONFLICT, conflicts })

  const seq = meta.seq + 1
  const hash = crypto.hash([meta.hash, node.value])

  for (const e of entries) {
    if (e.value) {
      tx.put(keys.files.encode(e.path), e.value)
      const h = e.decoded.hash
      if (h && !(await tx.has(keys.hash(h)))) tx.put(keys.hash(h), e.value)
    } else {
      tx.del(keys.files.encode(e.path))
    }
    tx.put(keys.path(e.path), c.encode(PathRecord, { seq }))
    tx.put(keys.hist(e.path, seq), b4a.alloc(0))
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
      blobs: op.blobs
    })
  )
  tx.setMeta({ seq, hash })

  return tx.outcome(node, { status: ACCEPTED, seq })
}

function addWriter(tx, node, op, host) {
  host.addWriter(op.key, { isIndexer: !!op.indexer })
  return tx.outcome(node, { status: ACCEPTED })
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
    this._meta = buf ? c.decode(Meta, buf) : { seq: 0, hash: keys.ZERO }
    return this._meta
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
  ACCEPTED,
  CONFLICT,
  STALE_BASE,
  INVALID,
  STATUS
}
