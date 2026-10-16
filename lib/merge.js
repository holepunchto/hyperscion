const { merge, diff3Merge, diffComm } = require('node-diff3')
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

// Union merge for append-mostly files (team notes, logs): clean hunks as in diff3; where both
// sides changed the same region, keep their (already landed) lines followed by our lines they
// don't already have, so appends stay in landing order. Never produces markers.
exports.union = function union(base, ours, theirs) {
  const split = (b) => b4a.toString(b).split('\n')
  const out = []
  for (const block of diff3Merge(split(ours), split(base), split(theirs))) {
    if (block.ok) {
      out.push(...block.ok)
      continue
    }
    const { a, b } = block.conflict
    const have = new Set(b)
    out.push(...b, ...a.filter((line) => !have.has(line)))
  }
  return { clean: true, content: b4a.from(out.join('\n')) }
}

// /.hsattributes: one rule per line, "<pattern> <attr>...", '#' comments. A pattern without
// '/' matches the basename anywhere; with '/' it matches the full path. '*' matches within one
// path segment, and a pattern ending in '/' covers that directory and everything below it.
// Attributes:
//   merge=<strategy>  how sync merges the path (union: concurrent appends never conflict)
//   -check            no `land --check` reads it: main moving only here doesn't re-run checks
exports.parseAttributes = function parseAttributes(buf) {
  const rules = []
  // a buffer (workspace reads) or a string (the CLI's mainText); under Bare, b4a.toString of a
  // string is ''
  const text = typeof buf === 'string' ? buf : b4a.toString(buf || b4a.alloc(0))
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const [pattern, ...attrs] = line.split(/\s+/)
    const rule = { pattern, re: patternToRegExp(pattern) }
    const m = attrs.map((a) => a.match(/^merge=(\w+)$/)).find(Boolean)
    if (m) rule.merge = m[1]
    if (attrs.includes('-check')) rule.check = false
    else if (attrs.includes('check')) rule.check = true
    if (rule.merge || rule.check !== undefined) rules.push(rule)
  }
  return rules
}

function attrSubject(rule, path) {
  return rule.pattern.includes('/')
    ? path.replace(/^\//, '')
    : path.slice(path.lastIndexOf('/') + 1)
}

exports.strategyFor = function strategyFor(rules, path) {
  let strategy = 'text'
  for (const r of rules) {
    if (r.merge && r.re.test(attrSubject(r, path))) strategy = r.merge // later rules win
  }
  return strategy
}

// whether a `land --check` may read the path (unless /.hsattributes says otherwise, it may)
exports.checkReads = function checkReads(rules, path) {
  let reads = true
  for (const r of rules) {
    if (r.check !== undefined && r.re.test(attrSubject(r, path))) reads = r.check
  }
  return reads
}

function patternToRegExp(pattern) {
  if (!pattern.endsWith('/')) return globToRegExp(pattern)
  const dir = globToRegExp(pattern.slice(0, -1)).source.slice(0, -1) // drop the '$'
  return new RegExp(dir + '/')
}

exports.globToRegExp = globToRegExp

function globToRegExp(glob) {
  const body = glob
    .replace(/^\//, '')
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp('^' + body + '$')
}

// unified diff of two text buffers (null = absent), git style with `context` lines
// lines without the empty string a trailing newline would leave
function textLines(buf) {
  const lines = b4a.toString(buf).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

exports.unifiedDiff = function unifiedDiff(path, before, after, { context = 3 } = {}) {
  if ((before && !exports.isText(before)) || (after && !exports.isText(after))) {
    return `--- a${path}\n+++ b${path}\nbinary file changed\n`
  }
  const a = before ? textLines(before) : []
  const b = after ? textLines(after) : []

  // flatten diffComm into a line-level edit script
  const lines = []
  for (const part of diffComm(a, b)) {
    if (part.common) for (const l of part.common) lines.push([' ', l])
    else {
      for (const l of part.buffer1) lines.push(['-', l])
      for (const l of part.buffer2) lines.push(['+', l])
    }
  }

  const changed = lines.map((l, i) => (l[0] !== ' ' ? i : -1)).filter((i) => i >= 0)
  if (!changed.length) return ''

  let out = `--- ${before ? 'a' + path : '/dev/null'}\n+++ ${after ? 'b' + path : '/dev/null'}\n`
  let i = 0
  while (i < changed.length) {
    const start = Math.max(0, changed[i] - context)
    let end = Math.min(lines.length, changed[i] + context + 1)
    while (i + 1 < changed.length && changed[i + 1] - context <= end) {
      i++
      end = Math.min(lines.length, changed[i] + context + 1)
    }
    let aStart = 1
    let bStart = 1
    for (let k = 0; k < start; k++) {
      if (lines[k][0] !== '+') aStart++
      if (lines[k][0] !== '-') bStart++
    }
    const hunk = lines.slice(start, end)
    const aLen = hunk.filter((l) => l[0] !== '+').length
    const bLen = hunk.filter((l) => l[0] !== '-').length
    // like diff(1): an empty side is numbered from the line before it
    out += `@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@\n`
    for (const [op, l] of hunk) out += op + l + '\n'
    i++
  }
  return out
}
