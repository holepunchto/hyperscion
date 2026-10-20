// The run scoring rules (scripts/experiment/metrics.js) on fixture traces and code snippets:
// which calls are coordination, what a wait waited for, round trips per land, and which files
// implement a change request's computation rather than repeat it as a fallback.
const test = require('brittle')
const m = require('../scripts/experiment/metrics')

const rec = (agent, t, argv, out = [], ms = 1000) => ({
  agent,
  t: new Date(Date.UTC(2026, 9, 17, 12, 0, t)).toISOString(),
  argv,
  ms,
  exit: 0,
  out
})

test('metrics: calls are change control, coordination, waits, the feed or help', (t) => {
  t.is(m.classify(rec('a1', 0, ['land', '-m', 'x'])), 'base')
  t.is(m.classify(rec('a1', 0, ['status'])), 'base')
  t.is(m.classify(rec('a1', 0, ['claims'])), 'coordination')
  t.is(m.classify(rec('a1', 0, ['propose', '-m', 'p'])), 'coordination')
  t.is(m.classify(rec('a1', 0, ['restore', 'CONTRACTS.md'])), 'coordination')
  t.is(m.classify(rec('a1', 0, ['watch', '--json'])), 'feed')
  t.is(m.classify(rec('a1', 0, ['watch', '--path', 'src/a.js', '--count', '1'])), 'wait')
  t.is(m.classify(rec('a1', 0, ['wait-final'])), 'wait')
  t.is(m.classify(rec('a1', 0, ['land', '--help'])), 'help')
})

test('metrics: a wait is for the scenario, a teammate or settlement', (t) => {
  const w = (...a) => m.waitTarget(rec('a1', 0, ['watch', ...a, '--count', '1']))
  t.is(w('--path', '/CHANGE-REQUEST.md'), 'scenario')
  t.is(w('--for-me'), 'scenario')
  t.is(w('--path', 'TASKS.md'), 'scenario')
  t.is(w('--path', 'src/scheduler.js'), 'teammate')
  t.is(w('--path', 'NOTES.md', '--path', 'src/geo.js'), 'teammate')
  t.is(m.waitTarget(rec('a1', 0, ['wait-final'])), 'settle')
  t.is(m.waitTarget(rec('a1', 0, ['land'])), null)
})

test('metrics: coordination cost of a run', (t) => {
  const started = Date.UTC(2026, 9, 17, 12, 0, 0)
  const recs = [
    rec('a1', 1, ['watch', '--json'], [], 300000), // the feed: not counted
    rec('a1', 10, ['claims']),
    rec('a1', 20, ['claim', 'C1']),
    rec('a1', 60, ['land', '-m', 'x'], ['landed #4']),
    rec('a1', 70, ['watch', '--path', 'src/b.js', '--count', '1'], [], 30000),
    rec('a1', 120, ['land', '-m', 'y'], ['landed P2 as #9']),
    rec('a2', 30, ['watch', '--path', '/CHANGE-REQUEST.md', '--count', '1'], [], 20000),
    rec('a2', 90, ['land', '-m', 'z'], ['!! not landed: needs review']),
    rec('a2', 150, ['land', '-m', 'z'], ['landed #12'])
  ]
  const c = m.coordinationMetrics(recs, started)
  t.is(c.coordination_calls, 2)
  t.is(c.coordination_share, 0.25)
  t.is(c.wait_teammate_s, 30)
  t.is(c.wait_scenario_s, 20)
  t.is(c.first_land_min, 1.8, 'median of a1 at 1.0 and a2 at 2.5, to one decimal')
  t.is(c.round_trips_per_land, 2.7, 'a1: 3 then 2, a2: 3')
  t.is(c.round_trips_per_land_p90, 3)
})

test('metrics: an implementation, a defensive fallback, and a file without it', (t) => {
  const dup = {
    all: ['flight.?min', 'speedKmh'],
    fallback: ['\\.flight_?\\w*min\\w*\\s*(\\?\\?|\\|\\|)']
  }
  const scheduler = `stop.flightMinutes = (km / drone.speedKmh) * 60`
  const pricing = `const min = stop.flightMinutes ?? (km / drone.speedKmh) * 60`
  const ownPricing = `function flightMinutes(trip) { return (trip.km / trip.speedKmh) * 60 }`
  const report = `console.log(stop.flightMinutes)`
  t.is(m.classifyImplementation(scheduler, dup), 'define')
  t.is(m.classifyImplementation(pricing, dup), 'fallback')
  t.is(m.classifyImplementation(ownPricing, dup), 'define', 'computing it yourself is a duplicate')
  t.is(m.classifyImplementation(report, dup), null)
  t.is(m.classifyImplementation(pricing, { all: dup.all }), 'define', 'the old rule')
})
