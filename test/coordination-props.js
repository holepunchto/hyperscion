// Tier 0b: the planning and review rules without change control in the way. Pure property
// tests over lib/claims.js (the board: who leads an item) and apply's line rule for approvals,
// thousands of cases a second: the outcome must not depend on the order signals arrive in,
// on duplicates, or on lost renewals, and an approval must survive teammates' lines merging
// around it but never an extra line. (The CLI and network layers, where every regression so
// far was, are tier 0: test/flows.js.)
const test = require('brittle')
const b4a = require('b4a')
const claims = require('../lib/claims')
const { lineDelta } = require('../lib/apply')

// a small seeded generator, so a failure names a case that can be replayed
function rng(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]
const shuffle = (r, xs) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
const key = (n) => b4a.alloc(32, n)
const hex = (b) => b4a.toString(b, 'hex')

function verdict(board, item, now) {
  const l = board.lead(item, now)
  if (!l) return 'none'
  return (
    hex(l.lead.writer) +
    '|' +
    l.coLeads
      .map((p) => hex(p.writer))
      .sort()
      .join(',')
  )
}

// one team's claims on one item: claims (some sharing with --with), renewals, a release
function scenario(r, now) {
  const item = key(200)
  const writers = [1, 2, 3, 4, 5].slice(0, 2 + Math.floor(r() * 4)).map(key)
  const named = r() < 0.3 ? pick(r, writers) : null
  const ops = [
    { item, action: claims.NEW, writer: key(99), time: now - 60_000, title: 'CR', lead: named }
  ]
  for (const w of writers) {
    if (r() < 0.2) continue // never claims
    const time = now - Math.floor(r() * 30_000)
    const withs = r() < 0.3 ? [pick(r, writers)].filter((x) => !b4a.equals(x, w)) : []
    ops.push({ item, action: claims.CLAIM, writer: w, time, at: time, with: withs })
    if (r() < 0.5) {
      // a renewal before the release (a writer's own actions are ordered by its clock)
      const at = Math.min(time + 1000 + Math.floor(r() * 5000), now - 20)
      ops.push({ item, action: claims.HEARTBEAT, writer: w, time, at })
    }
    if (r() < 0.15) ops.push({ item, action: claims.RELEASE, writer: w, time, at: now - 10 })
  }
  return { item, ops }
}

test('props: the lead does not depend on arrival order, duplicates or lost renewals', (t) => {
  const now = 10_000_000
  let cases = 0
  let failures = 0
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed)
    const { item, ops } = scenario(r, now)
    const ref = new claims.Board()
    for (const p of ops) ref.add(p)
    const want = verdict(ref, item, now)
    for (let k = 0; k < 20; k++) {
      // shuffled, some signals delivered twice, some renewals lost (relays don't guarantee
      // order or delivery; renewals only move the TTL, which is far off here)
      let delivered = shuffle(r, ops).flatMap((p) => (r() < 0.2 ? [p, p] : [p]))
      delivered = delivered.filter((p) => p.action !== claims.HEARTBEAT || r() < 0.5)
      const b = new claims.Board()
      for (const p of delivered) b.add(p)
      cases++
      const got = verdict(b, item, now)
      if (got !== want) {
        failures++
        if (failures <= 3) t.fail(`seed ${seed} case ${k}: ${got} vs ${want}`)
      }
    }
  }
  t.is(failures, 0, `${cases} cases`)
})

test('props: approved lines survive teammates merging around them; any extra line fails', (t) => {
  let cases = 0
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed)
    const base = Array.from({ length: 4 + Math.floor(r() * 8) }, (_, i) => `## section ${i}`)
    // my approved change: some lines added, maybe one removed
    const mine = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => `mine ${seed}.${i}`)
    const removed = r() < 0.3 ? base[Math.floor(r() * base.length)] : null
    const insertAt = (lines, add) => {
      const out = [...lines]
      for (const l of add) out.splice(Math.floor(r() * (out.length + 1)), 0, l)
      return out
    }
    const proposed = insertAt(
      base.filter((l) => l !== removed),
      mine
    )
    const approved = lineDelta(base.join('\n'), proposed.join('\n'))
    // teammates' approved sections land first, anywhere in the file
    const theirs = Array.from({ length: Math.floor(r() * 4) }, (_, i) => `theirs ${seed}.${i}`)
    const main = insertAt(base, theirs)
    // my land after the merge: their lines and mine, my removal
    const merged = insertAt(
      main.filter((l) => l !== removed),
      mine
    )
    const now = lineDelta(main.join('\n'), merged.join('\n'))
    cases++
    t.alike(now, approved, `seed ${seed}: the same lines as approved`)
    const sneaky = lineDelta(main.join('\n'), [...merged, `sneaky ${seed}`].join('\n'))
    t.unlike(sneaky, approved, `seed ${seed}: an extra line is not what was approved`)
  }
  t.comment(`${cases} merges`)
})
