// Path rules shared by the CLI and apply:
//   /.hsreview  "<pattern> approvals=<n> [reviewers=a3,a4]"  enforced by apply (Ask required)
//   /.hsowners  "<pattern> <handle> [<handle>...]"            a CLI nudge (Show to owners)
// Patterns work like .hsattributes: no '/' matches the basename anywhere, with '/' the full
// path, '*' within one segment. For owners the last matching line wins (like CODEOWNERS); for
// review the strictest matching rule wins.
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { getEncoding } = require('./schema/spec')
const { globToRegExp } = require('./merge')

const Entry = getEncoding('@hs/entry')

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
}

function matches(rule, path) {
  const subject = rule.pattern.includes('/')
    ? path.replace(/^\//, '')
    : path.slice(path.lastIndexOf('/') + 1)
  return rule.re.test(subject)
}

exports.parseReview = function parseReview(text) {
  const rules = []
  for (const line of lines(text)) {
    const [pattern, ...attrs] = line.split(/\s+/)
    if (pattern === 'item') continue // item rules (parseItemRules)
    let approvals = 0
    let reviewers = []
    for (const a of attrs) {
      const m = a.match(/^approvals=(\d+)$/)
      if (m) approvals = Math.min(Number(m[1]), 64)
      const r = a.match(/^reviewers=([\w,@-]+)$/)
      if (r) reviewers = r[1].split(',').filter(Boolean)
    }
    if (approvals > 0) rules.push({ pattern, re: globToRegExp(pattern), approvals, reviewers })
  }
  return rules
}

// the strictest rule covering any of the paths: { approvals, reviewers, pattern, paths } or null
exports.requirement = function requirement(rules, paths) {
  let req = null
  for (const p of paths) {
    for (const r of rules) {
      if (!matches(r, p)) continue
      if (!req || r.approvals > req.approvals) req = { ...r, paths: [] }
      if (req.pattern === r.pattern) req.paths.push(p)
    }
  }
  return req
}

// /.hsreview item rules (docs/CLAIMS.md, phase 2): "item kind=<k> [path=<glob>] approvals=<n>
// [reviewers=a3,@humans]": an item of that kind (and/or touching that path) needs approvals
// before it counts as approved. A rule needs a kind or a path.
exports.parseItemRules = function parseItemRules(text) {
  const out = []
  for (const line of lines(text)) {
    const [first, ...attrs] = line.split(/\s+/)
    if (first !== 'item') continue
    const rule = { kind: null, path: null, re: null, approvals: 0, reviewers: [] }
    for (const a of attrs) {
      let m = a.match(/^kind=([\w-]+)$/)
      if (m) rule.kind = m[1]
      m = a.match(/^path=(\S+)$/)
      if (m) {
        rule.path = m[1]
        rule.re = globToRegExp(m[1])
      }
      m = a.match(/^approvals=(\d+)$/)
      if (m) rule.approvals = Math.min(Number(m[1]), 64)
      m = a.match(/^reviewers=([\w,@-]+)$/)
      if (m) rule.reviewers = m[1].split(',').filter(Boolean)
    }
    if (rule.approvals > 0 && (rule.kind || rule.path)) out.push(rule)
  }
  return out
}

// the strictest item rule matching an item's kind and paths, or null
exports.itemRequirement = function itemRequirement(itemRules, { kind = '', paths = [] }) {
  let req = null
  for (const r of itemRules) {
    if (r.kind && r.kind !== kind) continue
    if (r.path && !paths.some((p) => matches({ pattern: r.path, re: r.re }, p))) continue
    if (!req || r.approvals > req.approvals) req = r
  }
  return req
}

// what an item's approvals bind to: its id, title, kind, paths (sorted) and suggested lead,
// everything the approver saw, and who besides its author may land under it
exports.itemHash = function itemHash({ id, title = '', kind = '', paths = [], lead = null }) {
  return crypto.hash([
    id,
    c.encode(c.string, title),
    c.encode(c.string, kind),
    c.encode(c.array(c.string), [...paths].sort()),
    lead || b4a.alloc(32)
  ])
}

// does an item's path list cover a path (equal, or inside a listed directory)
exports.covers = function covers(itemPaths, p) {
  return itemPaths.some((ip) => p === ip || p.startsWith(ip.replace(/\/$/, '') + '/'))
}

exports.parseOwners = function parseOwners(text) {
  const rules = []
  for (const line of lines(text)) {
    const [pattern, ...owners] = line.split(/\s+/)
    rules.push({ pattern, re: globToRegExp(pattern), owners })
  }
  return rules
}

exports.ownersOf = function ownersOf(rules, path) {
  let owners = []
  for (const r of rules) if (matches(r, path)) owners = r.owners
  return owners
}

// the content hash approvals bind to: canonical encoding of entries sorted by path
exports.contentHash = function contentHash(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return crypto.hash(sorted.map((e) => c.encode(Entry, { path: e.path, value: e.value || null })))
}

exports.HANDLE = /^[a-z0-9][a-z0-9_-]{0,31}$/
