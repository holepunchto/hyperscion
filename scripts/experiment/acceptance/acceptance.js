// Hidden acceptance suite for Skyhop. Agents are told not to read this repo; keep it that way. Scores a tree through the CLI
// contract pinned in CONTRACTS.md (`plan <day> --json`), so it works on any team's code.
//   node acceptance.js <tree> [--per-minute]      prints JSON { passed, total, failures }
// --per-minute also checks prices against the S2 change request formula.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const tree = path.resolve(args.find((a) => !a.startsWith('--')))
const perMinute = args.includes('--per-minute')
const FIX = path.join(__dirname, 'fixtures')

const results = []
function check(name, fn) {
  try {
    const r = fn()
    results.push({
      name,
      ok: r === true || r === undefined,
      why: r === true || r === undefined ? null : String(r)
    })
  } catch (err) {
    results.push({ name, ok: false, why: String(err.message || err).slice(0, 200) })
  }
}

function cli(...argv) {
  const r = spawnSync('node', ['src/cli.js', ...argv], {
    cwd: tree,
    encoding: 'utf8',
    timeout: 30000
  })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function km(a, b) {
  const R = 6371
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function planOf(file) {
  const r = cli('plan', path.join(FIX, file), '--json')
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr.slice(0, 150)}`)
  return JSON.parse(r.stdout)
}

function failAll(file, mustUnassign, why) {
  const names = [
    'every package once',
    'reasons',
    ...mustUnassign.map((id) => id + ' unassigned'),
    'payload',
    'range',
    'windows',
    'prices',
    'deterministic',
    'report'
  ]
  if (perMinute) names.push('per-minute prices (change request)')
  for (const n of names) results.push({ name: `${file}: ${n}`, ok: false, why })
}

function checkDay(file, { mustUnassign = [] } = {}) {
  const day = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'))
  const pkg = new Map(day.packages.map((p) => [p.id, p]))
  const drone = new Map(day.drones.map((d) => [d.id, d]))
  const depot = new Map(day.depots.map((d) => [d.id, d]))
  let plan = null
  check(`${file}: --json exits 0 and parses`, () => {
    plan = planOf(file)
  })
  if (!plan) return failAll(file, mustUnassign, 'no plan')
  const trips = Array.isArray(plan.trips) ? plan.trips : []
  const unassigned = Array.isArray(plan.unassigned) ? plan.unassigned : []
  const delivered = trips.flatMap((t) => t.packages || [])

  if (!Array.isArray(plan.trips) || !Array.isArray(plan.unassigned)) {
    // the pinned shape is missing: every property check fails rather than passing vacuously
    return failAll(file, mustUnassign, 'no trips/unassigned arrays')
  }
  check(`${file}: every package exactly once (delivered or unassigned)`, () => {
    const seen = [...delivered, ...unassigned.map((u) => u.id)]
    const dup = seen.filter((id, i) => seen.indexOf(id) !== i)
    const missing = [...pkg.keys()].filter((id) => !seen.includes(id))
    const unknown = seen.filter((id) => !pkg.has(id))
    if (dup.length || missing.length || unknown.length) {
      return `dup ${dup} missing ${missing} unknown ${unknown}`
    }
  })
  check(`${file}: every unassigned package has a reason`, () => {
    const bad = unassigned.filter((u) => !u.reason || typeof u.reason !== 'string')
    return bad.length ? 'no reason for ' + bad.map((u) => u.id) : true
  })
  for (const id of mustUnassign) {
    check(`${file}: ${id} is unassigned`, () =>
      unassigned.some((u) => u.id === id) ? true : 'delivered'
    )
  }
  check(`${file}: payload per trip`, () => {
    for (const t of trips) {
      const d = drone.get(t.drone)
      if (!d) return 'unknown drone ' + t.drone
      const kg = (t.packages || []).reduce((s, id) => s + (pkg.get(id)?.weightKg || 0), 0)
      if (kg > d.maxPayloadKg + 1e-9) return `${t.drone} carries ${kg} > ${d.maxPayloadKg}`
    }
  })
  check(`${file}: range per trip`, () => {
    for (const t of trips) {
      const d = drone.get(t.drone)
      const home = depot.get(d.depot)
      let at = home
      let total = 0
      for (const id of t.packages || []) {
        total += km(at, pkg.get(id).destination)
        at = pkg.get(id).destination
      }
      total += km(at, home)
      if (total > d.rangeKm * 1.001) return `${t.drone} flies ${total.toFixed(2)} > ${d.rangeKm}`
    }
  })
  // waiting at a stop is allowed; service may count before or after the hand-over
  check(`${file}: windows, day length and no overlapping trips`, () => {
    const busy = new Map()
    for (const t of trips) {
      if (typeof t.start !== 'number') return 'trip without numeric start'
      const d = drone.get(t.drone)
      const home = depot.get(d.depot)
      let now = t.start
      let at = home
      for (const id of t.packages || []) {
        const p = pkg.get(id)
        now += (km(at, p.destination) / d.speedKmh) * 60
        at = p.destination
        if (p.window) {
          if (now > p.window[1] + day.serviceMinutes + 0.5) {
            return `${id} arrives ${now.toFixed(1)} after ${p.window[1]}`
          }
          now = Math.max(now, p.window[0])
        }
        now += day.serviceMinutes
      }
      now += (km(at, home) / d.speedKmh) * 60
      if (now > day.dayLengthMinutes + 1) return `${t.drone} trip ends at ${now.toFixed(1)}`
      ;(busy.get(t.drone) || busy.set(t.drone, []).get(t.drone)).push([t.start, now])
    }
    for (const [id, spans] of busy) {
      spans.sort((a, b) => a[0] - b[0])
      for (let i = 1; i < spans.length; i++) {
        if (spans[i][0] < spans[i - 1][1] - 1) return `${id} trips overlap`
      }
    }
  })
  check(`${file}: a price for every delivered package, total is their sum`, () => {
    const prices = plan.prices || {}
    for (const id of delivered) {
      if (!(typeof prices[id] === 'number' && prices[id] > 0)) return 'no price for ' + id
    }
    const sum = delivered.reduce((s, id) => s + prices[id], 0)
    if (typeof plan.total !== 'number' || Math.abs(plan.total - sum) > 0.05) {
      return `total ${plan.total} != ${sum}`
    }
  })
  if (perMinute) {
    // S2 change request: 2.00 + 0.25/flight minute to the stop + 0.40/kg, express x1.5, cents
    check(`${file}: per-minute prices (change request)`, () => {
      if (!delivered.length) return 'nothing delivered'
      for (const t of trips) {
        const d = drone.get(t.drone)
        let at = depot.get(d.depot)
        let mins = 0
        for (const id of t.packages || []) {
          const p = pkg.get(id)
          mins += (km(at, p.destination) / d.speedKmh) * 60
          at = p.destination
          let want = 2 + 0.25 * mins + 0.4 * p.weightKg
          if (p.priority === 'express') want *= 1.5
          want = Math.round(want * 100) / 100
          if (Math.abs(plan.prices[id] - want) > 0.011) {
            return `${id}: ${plan.prices[id]} != ${want}`
          }
        }
      }
    })
  }
  check(`${file}: deterministic`, () => {
    const a = cli('plan', path.join(FIX, file), '--json').stdout
    return a === JSON.stringify(plan) || JSON.stringify(JSON.parse(a)) === JSON.stringify(plan)
      ? true
      : 'differs between runs'
  })
  check(`${file}: human report exits 0 and names every delivered package`, () => {
    const r = cli('plan', path.join(FIX, file))
    if (r.code !== 0) return 'exit ' + r.code
    const missing = delivered.filter((id) => !r.stdout.includes(id))
    return missing.length ? 'report misses ' + missing.slice(0, 5) : true
  })
}

checkDay('day1.json', { mustUnassign: ['p19'] })
checkDay('hidden-mixed.json', { mustUnassign: ['h15', 'h16', 'h17'] })
check('hidden-empty.json: exits 0 with no trips', () => {
  const plan = planOf('hidden-empty.json')
  return (plan.trips || []).length === 0 ? true : 'has trips'
})
check('hidden-invalid.json: unknown depot fails with a message', () => {
  const r = cli('plan', path.join(FIX, 'hidden-invalid.json'), '--json')
  if (r.code === 0) return 'exit 0'
  return r.stderr.trim() ? true : 'no message on stderr'
})
check('missing file fails with a message', () => {
  const r = cli('plan', path.join(FIX, 'nope.json'))
  return r.code !== 0 && r.stderr.trim() ? true : 'exit ' + r.code
})

const failures = results.filter((r) => !r.ok)
console.log(
  JSON.stringify(
    { passed: results.length - failures.length, total: results.length, failures },
    null,
    2
  )
)
