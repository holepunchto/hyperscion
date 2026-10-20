const { merge } = require('node-diff3')
const b4a = require('b4a')

const SNIFF = 8000

exports.isText = function isText(buf) {
  const n = Math.min(buf.byteLength, SNIFF)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false
  return true
}

// line-based 3-way merge; on conflict the content carries git-style markers
exports.diff3 = function diff3(base, ours, theirs) {
  const split = (b) => b4a.toString(b).split('\n')
  const res = merge(split(ours), split(base), split(theirs), {
    label: { a: 'ours', o: 'base', b: 'theirs' }
  })
  return { clean: !res.conflict, content: b4a.from(res.result.join('\n')) }
}
