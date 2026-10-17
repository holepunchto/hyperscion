// Keyspaces inside main's view bee. `files` is shared with Hyperdrive so the view is a drive.
const SubEncoder = require('sub-encoder')
const b4a = require('b4a')
const c = require('compact-encoding')

const files = new SubEncoder('files', 'utf-8')
const paths = new SubEncoder('hs-paths', 'utf-8')
const hist = new SubEncoder('hs-hist', 'binary')
const cs = new SubEncoder('hs-cs', 'binary')
const ops = new SubEncoder('hs-ops', 'binary')
const hashes = new SubEncoder('hs-hash', 'binary')
const meta = new SubEncoder('hs-meta', 'utf-8')
const writers = new SubEncoder('hs-writer', 'binary')
const handles = new SubEncoder('hs-handle', 'utf-8')
const props = new SubEncoder('hs-prop', 'binary')
const reviews = new SubEncoder('hs-rev', 'binary')
const requests = new SubEncoder('hs-req', 'binary')
const events = new SubEncoder('hs-ev', 'binary')
const policy = new SubEncoder('hs-policy', 'utf-8')
const seen = new SubEncoder('hs-seen', 'binary')
const items = new SubEncoder('hs-item', 'binary')
const claims = new SubEncoder('hs-claim', 'binary')
const itemReviews = new SubEncoder('hs-irev', 'binary')

// review targets: a proposal or a landed changeset
const TARGET_PROPOSAL = 1
const TARGET_CHANGESET = 2

function seqRange(enc, { gt = 0, lte = Infinity, reverse = false, limit } = {}) {
  const range = { gt: seqBuffer(gt) }
  if (lte !== Infinity) range.lte = seqBuffer(lte)
  return { ...enc.encodeRange(range), reverse, limit }
}

const ZERO = b4a.alloc(32)

function seqBuffer(seq) {
  const buf = b4a.allocUnsafe(8)
  const view = new DataView(buf.buffer, buf.byteOffset, 8)
  view.setBigUint64(0, BigInt(seq))
  return buf
}

function seqFromBuffer(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, 8)
  return Number(view.getBigUint64(0))
}

module.exports = {
  ZERO,
  files,
  meta: meta.encode('main'),

  path(p) {
    return paths.encode(p)
  },

  // path history sorts by path then seq, so `hs log <path>` is one range read
  hist(p, seq) {
    return hist.encode(b4a.concat([b4a.from(p), b4a.alloc(1), seqBuffer(seq)]))
  },

  histRange(p, { reverse = true } = {}) {
    const prefix = b4a.concat([b4a.from(p), b4a.alloc(1)])
    return {
      ...hist.encodeRange({ gte: prefix, lt: b4a.concat([b4a.from(p), b4a.from([1])]) }),
      reverse
    }
  },

  // every path's history, path by path (for rebuilding main's tree at an older seq)
  histAll() {
    return hist.encodeRange({})
  },

  histPath(key) {
    const raw = hist.decode(key)
    return b4a.toString(raw.subarray(0, raw.byteLength - 9))
  },

  histSeq(key) {
    const raw = hist.decode(key)
    return seqFromBuffer(raw.subarray(raw.byteLength - 8))
  },

  cs(seq) {
    return cs.encode(seqBuffer(seq))
  },

  csRange({ gt = 0, lte = Infinity, reverse = false, limit } = {}) {
    const range = { gt: seqBuffer(gt) }
    if (lte !== Infinity) range.lte = seqBuffer(lte)
    return { ...cs.encodeRange(range), reverse, limit }
  },

  op(writer, length) {
    return ops.encode(b4a.concat([writer, c.encode(c.uint, length)]))
  },

  hash(h) {
    return hashes.encode(h)
  },

  TARGET_PROPOSAL,
  TARGET_CHANGESET,
  seqFromBuffer,
  policy: policy.encode('current'),

  writer(key) {
    return writers.encode(key)
  },

  // hs-seen/<writer>: the highest main seq this writer is known to have seen
  seen(key) {
    return seen.encode(key)
  },

  seenRange() {
    return seen.encodeRange({})
  },

  seenKeyOf(key) {
    return seen.decode(key)
  },

  writerRange() {
    return writers.encodeRange({})
  },

  writerKeyOf(key) {
    return writers.decode(key)
  },

  handle(h) {
    return handles.encode(h)
  },

  prop(id) {
    return props.encode(seqBuffer(id))
  },

  propRange(opts) {
    return seqRange(props, opts)
  },

  // hs-rev/<kind><id>/<writer>: one record per reviewer per target
  review(kind, id, writer) {
    return reviews.encode(b4a.concat([b4a.from([kind]), seqBuffer(id), writer]))
  },

  reviewRange(kind, id) {
    const prefix = b4a.concat([b4a.from([kind]), seqBuffer(id)])
    const end = b4a.concat([prefix, b4a.alloc(33, 0xff)])
    return reviews.encodeRange({ gte: prefix, lt: end })
  },

  request(seq) {
    return requests.encode(seqBuffer(seq))
  },

  requestRange(opts) {
    return seqRange(requests, opts)
  },

  requestSeq(key) {
    return seqFromBuffer(requests.decode(key))
  },

  event(n) {
    return events.encode(seqBuffer(n))
  },

  eventRange(opts) {
    return seqRange(events, opts)
  },

  // hs-item/<id>: items (docs/CLAIMS.md), keyed by their content id
  item(id) {
    return items.encode(id)
  },

  itemRange() {
    return items.encodeRange({})
  },

  // hs-claim/<item><writer>: each writer's latest claim action on an item
  claim(item, writer) {
    return claims.encode(b4a.concat([item, writer]))
  },

  // hs-irev/<item><writer>: each reviewer's latest review of an item
  itemReview(item, writer) {
    return itemReviews.encode(b4a.concat([item, writer]))
  },

  itemReviewRange(item) {
    return itemReviews.encodeRange({ gte: item, lt: b4a.concat([item, b4a.alloc(32, 0xff)]) })
  },

  claimRange(item = null) {
    if (!item) return claims.encodeRange({})
    return claims.encodeRange({ gte: item, lt: b4a.concat([item, b4a.alloc(32, 0xff)]) })
  }
}
