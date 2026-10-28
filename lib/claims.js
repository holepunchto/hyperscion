// Claims (docs/TASKS.md): items, signed claim payloads, and the board that merges what main
// recorded with what the swarm signalled.
//
// One payload shape (@hs/item-op) travels two ways: as a signal (signed with the writer's
// local core key pair, checked on receipt) and inside an OP_ITEM record (the oplog signs it).
// The lead of an item is computed from the claims' content only: the earliest original claim
// time, then the smaller writer key. A renewal carries the original time (what the lead rule
// reads) with a new `at` (what the TTL reads), so renewing never moves the lead, and neither
// can a reorg or the order claims arrive in.
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { getEncoding } = require('./schema/spec')

const ItemOp = getEncoding('@hs/item-op')

const NEW = 1
const CLAIM = 3
const RELEASE = 4
const TAKE = 5
const HEARTBEAT = 6
const DONE = 7
const DROP = 8

// a claim lapses this long after its last renewal (HS_CLAIM_TTL_MS shortens it for tests)
const TTL_MS = Number(require('bare-process').env.HS_CLAIM_TTL_MS) || 20 * 60_000
// how long `hs task start` listens for anyone starting it too before it gives its verdict
const SETTLE_MS = 1500
// live claims per writer (soft: the CLI refuses a fourth, apply doesn't)
const MAX_LIVE = 3

const hex = (b) => b4a.toString(b, 'hex')

// an item's id: its creator, creation time, title and parent, hashed, so an item can be named
// (and claimed) before its record is ordered
function itemId({ writer, time, title, parent = null }) {
  const t = b4a.alloc(8)
  new DataView(t.buffer, t.byteOffset, 8).setBigUint64(0, BigInt(time))
  return crypto.hash([writer, t, b4a.from(title || ''), parent || b4a.alloc(32)])
}

function shortId(id) {
  return 'T' + hex(id).slice(0, 6)
}

function signable(p) {
  return c.encode(ItemOp, { ...p, sig: null })
}

function sign(payload, keyPair) {
  const p = { ...payload, signer: keyPair.publicKey }
  return { ...p, sig: crypto.sign(signable(p), keyPair.secretKey) }
}

// the signature is the writer's: its public key derives the writer's core key, and it signed
// this content. Whether that writer is admitted is the caller's check (main's writer records)
function verify(p) {
  try {
    if (!p.signer || !p.sig || !p.writer) return false
    if (!b4a.equals(Hypercore.key(p.signer), p.writer)) return false
    return crypto.verify(signable(p), p.sig, p.signer)
  } catch {
    return false
  }
}

function encode(p) {
  return c.encode(ItemOp, p)
}

function decode(buf) {
  return c.decode(ItemOp, buf)
}

// dedupe key for relaying signals
function messageId(p) {
  return hex(crypto.hash(encode(p)))
}

class Board {
  constructor() {
    this.items = new Map() // item hex -> { id, title, parent, kind, paths, author, time, done, dropped }
    this.claims = new Map() // item hex -> Map(writer hex -> latest payload)
    this.signals = new Map() // message id -> signed payload (what a snapshot sends)
  }

  // what main recorded: items and each writer's latest claim action
  async load(repo) {
    for (const it of await repo.items()) this._item(it, true)
    for (const p of await repo.claimRecords()) this._claim(p)
  }

  // a payload from a signal or a record; returns true if it changed the board
  add(p) {
    if (p.action === NEW) return this._item({ ...p, id: p.item, author: p.writer })
    if (p.action === DONE) {
      const it = this.items.get(hex(p.item)) || { id: p.item }
      if (it.done) return false
      this.items.set(hex(p.item), { ...it, done: it.done || -1, doneBy: p.writer })
      return true
    }
    if (p.action === DROP) {
      const it = this.items.get(hex(p.item))
      if (!it || it.dropped) return false
      this.items.set(hex(p.item), { ...it, dropped: true })
      return true
    }
    return this._claim(p)
  }

  // remember a signed signal so it can be relayed and sent in snapshots
  remember(p) {
    const id = messageId(p)
    if (this.signals.has(id)) return false
    this.signals.set(id, p)
    return true
  }

  // live signals, for a snapshot: items and claims that haven't expired
  snapshot(now = Date.now()) {
    const out = []
    for (const [id, p] of this.signals) {
      const expired =
        (p.action === CLAIM || p.action === TAKE || p.action === HEARTBEAT) &&
        (p.at || 0) + (p.ttl || TTL_MS) < now
      if (expired) this.signals.delete(id)
      else out.push(p)
    }
    return out
  }

  // a record (main's copy: needs, approvals) always refreshes what a signal said
  _item(it, record = false) {
    const key = hex(it.id)
    const prev = this.items.get(key)
    if (!record && prev && prev.author && !it.done && !it.dropped) return false
    this.items.set(key, {
      ...(prev || {}),
      ...it,
      done: it.done || (prev && prev.done) || 0,
      dropped: !!(it.dropped || (prev && prev.dropped))
    })
    return true
  }

  _claim(p) {
    const key = hex(p.item)
    if (!this.claims.has(key)) this.claims.set(key, new Map())
    const byWriter = this.claims.get(key)
    const prev = byWriter.get(hex(p.writer))
    // a heartbeat only renews a claim we know (relays don't guarantee order)
    if (p.action === HEARTBEAT && (!prev || prev.action === RELEASE)) return false
    if (prev && (prev.at || 0) >= (p.at || 0)) return false
    // a heartbeat renews a claim: it keeps the claim's original time
    const next = p.action === HEARTBEAT && prev ? { ...prev, at: p.at, ttl: p.ttl } : p
    byWriter.set(hex(p.writer), next)
    if (p.action !== HEARTBEAT) this._replayBeats(p)
    return true
  }

  // heartbeats that arrived before the claim they renew (a snapshot no longer carries a claim
  // signal past its first lease, and main's record loads after it): apply them now, or a
  // claim renewed all along looks lapsed to every peer that joins later
  _replayBeats(p) {
    for (const s of this.signals.values()) {
      if (
        s.action !== HEARTBEAT ||
        !b4a.equals(s.item, p.item) ||
        !b4a.equals(s.writer, p.writer)
      ) {
        continue
      }
      this._claim(s)
    }
  }

  item(id) {
    return this.items.get(hex(id)) || null
  }

  // per writer: { payload, state: 'live' | 'stale' | 'released' }
  claimsOn(id, now = Date.now()) {
    const out = []
    for (const p of (this.claims.get(hex(id)) || new Map()).values()) {
      let state = 'live'
      if (p.action === RELEASE) state = 'released'
      else if ((p.at || 0) + (p.ttl || TTL_MS) < now) state = 'stale'
      out.push({ payload: p, state })
    }
    return out
  }

  // the lead: the earliest original claim time among live claims, then the smaller key;
  // co-leads share it (--with, either way). null if nobody is live (or done)
  lead(id, now = Date.now()) {
    const it = this.item(id)
    if (it && (it.done || it.dropped)) return null
    const live = this.claimsOn(id, now)
      .filter((cl) => cl.state === 'live')
      .map((cl) => cl.payload)
    if (!live.length) return null
    // the item's suggested lead leads once they claim it (the author named them, e.g. a change
    // request that says "a3 leads"); otherwise the earliest claim. Both come from content
    const named = it && it.lead
    const rank = (p) => (named && b4a.equals(p.writer, named) ? 0 : 1)
    live.sort(
      (a, b) =>
        rank(a) - rank(b) || (a.time || 0) - (b.time || 0) || b4a.compare(a.writer, b.writer)
    )
    const lead = live[0]
    // shared either way: the lead named them, or they named the lead (asking to share)
    const coLeads = live.filter(
      (p) =>
        p !== lead &&
        ((lead.with || []).some((w) => b4a.equals(w, p.writer)) ||
          (p.with || []).some((w) => b4a.equals(w, lead.writer)))
    )
    return { lead, coLeads, others: live.slice(1).filter((p) => !coLeads.includes(p)) }
  }

  // a writer's live claims (for the 3-claim limit and status)
  liveClaimsOf(writer, now = Date.now()) {
    const out = []
    for (const [key, byWriter] of this.claims) {
      const p = byWriter.get(hex(writer))
      if (!p || p.action === RELEASE || (p.at || 0) + (p.ttl || TTL_MS) < now) continue
      const it = this.items.get(key)
      if (it && (it.done || it.dropped)) continue
      out.push(p)
    }
    return out
  }

  // live claims by others whose item or claim names any of these paths
  claimsTouching(paths, writer, now = Date.now()) {
    const out = []
    for (const [key, byWriter] of this.claims) {
      const it = this.items.get(key)
      if (it && (it.done || it.dropped)) continue
      for (const p of byWriter.values()) {
        if (b4a.equals(p.writer, writer)) continue
        if (p.action === RELEASE || (p.at || 0) + (p.ttl || TTL_MS) < now) continue
        const scope = [...((it && it.paths) || []), ...(p.paths || [])]
        const hit = paths.find((x) =>
          scope.some((s) => x === s || x.startsWith(s.replace(/\/$/, '') + '/'))
        )
        if (hit) out.push({ payload: p, item: it, path: hit })
      }
    }
    return out
  }
}

module.exports = {
  NEW,
  CLAIM,
  RELEASE,
  TAKE,
  HEARTBEAT,
  DONE,
  DROP,
  TTL_MS,
  SETTLE_MS,
  MAX_LIVE,
  itemId,
  shortId,
  sign,
  verify,
  encode,
  decode,
  messageId,
  Board
}
