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
  }
}
