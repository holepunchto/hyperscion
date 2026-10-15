// Path rules shared by the CLI and apply:
//   /.hsreview  "<pattern> approvals=<n> [reviewers=a3,a4]"  enforced by apply (Ask required)
//   /.hsowners  "<pattern> <handle> [<handle>...]"            a CLI nudge (Show to owners)
// Patterns work like .hsattributes: no '/' matches the basename anywhere, with '/' the full
// path, '*' within one segment. For owners the last matching line wins (like CODEOWNERS); for
// review the strictest matching rule wins.
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
    let approvals = 0
    let reviewers = []
    for (const a of attrs) {
      const m = a.match(/^approvals=(\d+)$/)
      if (m) approvals = Math.min(Number(m[1]), 64)
      const r = a.match(/^reviewers=([\w,-]+)$/)
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
