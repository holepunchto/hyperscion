// Scoring rules shared by the LLM runs' scripts (analyze.js, outcomes.js, on Node) and the
// scripted flows (test/flows.js, on Bare): pure functions over trace records and source
// text, no fs. A trace record is one hs call: { t, agent, argv, ms, exit, out: [lines] }.

// calls that only look at state
const OBSERVE = new Set(['log', 'show', 'cat', 'ls', 'diff', 'status', 'info', 'watch', 'doctor'])

// change control and looking at it: what any VCS needs. Everything an agent calls beyond
// these, waits and the feed is coordination (claims, items, proposals, reviews, inbox, and
// restore, which agents used to split protected files by hand)
const BASE = new Set([
  'land',
  'sync',
  'status',
  'diff',
  'log',
  'cat',
  'show',
  'ls',
  'info',
  'doctor',
  'fetch',
  'pull',
  'push',
  'commit',
  'clone',
  'init',
  'export'
])

// files a scenario makes everyone wait for (the change request, the team log, the task
// board): waiting on these is the scenario, not a teammate
const SCENARIO_PATHS = /CHANGE-REQUEST|NOTES\.md|TASKS\.md/

// an ask lands as `landed A5 as #27` (archived runs: `landed P5 as #27`)
const LANDED = /landed ([AP]\d+ as )?#\d+/

const has = (r, re) => (r.out || []).some((l) => re.test(l))

function isHelp(r) {
  const argv = r.argv || []
  return argv.includes('--help') || argv.includes('-h') || argv[0] === 'help'
}

// 'base' | 'coordination' | 'wait' | 'feed' | 'help'
function classify(r) {
  const argv = r.argv || []
  const cmd = argv[0] || ''
  if (isHelp(r)) return 'help'
  if (cmd === 'wait-final') return 'wait'
  if (cmd === 'keepalive') return 'feed' // a running feed calls it, not the agent
  if (cmd === 'watch') {
    if (argv.includes('--count') || argv.includes('-c')) return 'wait'
    return 'feed'
  }
  if (cmd === 'land' && argv.includes('--wait-final')) return 'base'
  return BASE.has(cmd) ? 'base' : 'coordination'
}

// what a wait was for: 'scenario' (the change request, team log, task board, or review
// activity), 'teammate' (their files), 'settle' (your land becoming final), or null
function waitTarget(r) {
  const argv = r.argv || []
  if (classify(r) !== 'wait') return null
  if (argv[0] === 'wait-final') return 'settle'
  if (argv.includes('--for-me')) return 'scenario'
  const paths = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path' || argv[i] === '-p') paths.push(argv[i + 1] || '')
  }
  if (paths.length && paths.every((p) => SCENARIO_PATHS.test(p))) return 'scenario'
  return 'teammate'
}

function accepted(r) {
  return (r.argv || [])[0] === 'land' && has(r, LANDED)
}

function pct(xs, p) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const round = (x, n = 2) => (x === null ? null : Number(x.toFixed(n)))

// coordination cost of a run: records of the agents only (filter before calling), started as
// a timestamp in ms
function coordinationMetrics(recs, started) {
  const byAgent = new Map()
  for (const r of recs) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, [])
    byAgent.get(r.agent).push(r)
  }
  let coordination = 0
  let counted = 0
  const waits = { scenario: 0, teammate: 0, settle: 0 }
  const firstLands = []
  const segments = []
  for (const list of byAgent.values()) {
    list.sort((a, b) => new Date(a.t) - new Date(b.t))
    let first = null
    let since = 0
    for (const r of list) {
      const kind = classify(r)
      if (kind === 'feed') continue // the background feed runs all session
      counted++
      since++
      if (kind === 'coordination') coordination++
      const target = waitTarget(r)
      if (target) waits[target] += r.ms || 0
      if (accepted(r)) {
        if (first === null) first = new Date(r.t).getTime()
        segments.push(since)
        since = 0
      }
    }
    if (first !== null) firstLands.push((first - started) / 60000)
  }
  return {
    coordination_calls: coordination,
    coordination_share: counted ? round(coordination / counted) : 0,
    wait_scenario_s: Math.round(waits.scenario / 1000),
    wait_teammate_s: Math.round(waits.teammate / 1000),
    wait_settle_s: Math.round(waits.settle / 1000),
    first_land_min: round(median(firstLands), 1),
    round_trips_per_land: segments.length
      ? round(segments.reduce((a, b) => a + b, 0) / segments.length, 1)
      : null,
    round_trips_per_land_p90: segments.length ? pct(segments, 90) : null
  }
}

// a source file and the computation a scenario watches for (duplication: { all, fallback,
// defines }):
// - null: the file doesn't carry it (not every `all` pattern matches);
// - 'fallback': it carries it only as a defensive copy, reading a teammate's value first and
//   computing it if that's missing (a `fallback` pattern matches, e.g. `stop.flightMinutes ??`);
// - 'define': otherwise. With `defines`, a carrier must also match one of them to count
//   (declares the computation as its own); without `fallback` or `defines`, every carrier is
//   a 'define' (the rule before either existed).
// A file that computes the value itself without reading anyone's is an implementation, even
// if a teammate's module also provides it: that is the duplication the metric is for.
function classifyImplementation(text, { all = [], fallback = null, defines = null } = {}) {
  if (!all.length || !all.every((r) => new RegExp(r, 'i').test(text))) return null
  if (fallback && fallback.some((r) => new RegExp(r, 'i').test(text))) return 'fallback'
  if (defines && defines.length && !defines.some((r) => new RegExp(r, 'im').test(text))) {
    return 'fallback'
  }
  return 'define'
}

// lands that only post to the team's shared notes (NOTES.md, a TASKS.md board): coordination
// done by landing, a round trip like a claim. changesets: feed records
// { type: 'changeset', hash, author, files }, deduplicated by hash; authorRe picks agents
const NOTE_FILES = new Set(['/NOTES.md', '/TASKS.md'])

function coordinationLands(changesets, authorRe = /^a\d+[a-z]*$/) {
  const seen = new Set()
  let n = 0
  for (const cs of changesets) {
    if (cs.type !== 'changeset' || !authorRe.test(cs.author || '') || seen.has(cs.hash)) continue
    seen.add(cs.hash)
    const files = (cs.files || []).map((f) => f.replace(/^-/, ''))
    if (files.length && files.every((f) => NOTE_FILES.has(f))) n++
  }
  return n
}

module.exports = {
  coordinationLands,
  OBSERVE,
  BASE,
  LANDED,
  classify,
  waitTarget,
  accepted,
  coordinationMetrics,
  classifyImplementation,
  pct,
  median
}
