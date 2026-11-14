// Assign packages to drones (owner: a2). One package per trip, greedy: express first, then
// the earliest window end; each package goes to the drone that can deliver it soonest.
const { distanceKm, travelMinutes } = require('./geo')

function plan(day) {
  const depot = new Map(day.depots.map((d) => [d.id, d]))
  const free = new Map(day.drones.map((d) => [d.id, 0])) // minute each drone is back home
  const order = [...day.packages].sort(
    (a, b) =>
      (a.priority === 'express' ? 0 : 1) - (b.priority === 'express' ? 0 : 1) ||
      (a.window ? a.window[1] : Infinity) - (b.window ? b.window[1] : Infinity) ||
      (a.id < b.id ? -1 : 1)
  )
  const trips = []
  const unassigned = []
  for (const p of order) {
    let best = null
    let why = 'too heavy for every drone'
    for (const d of day.drones) {
      if (p.weightKg > d.maxPayloadKg) continue
      const home = depot.get(d.depot)
      const km = distanceKm(home, p.destination)
      if (2 * km > d.rangeKm) {
        why = 'out of range'
        continue
      }
      const out = travelMinutes(km, d.speedKmh)
      let start = free.get(d.id)
      if (p.window && start + out < p.window[0]) start = p.window[0] - out
      const arrive = start + out
      if (p.window && arrive > p.window[1]) {
        why = 'no drone can make the delivery window'
        continue
      }
      const back = arrive + day.serviceMinutes + out
      if (back > day.dayLengthMinutes) {
        why = 'does not fit in the day'
        continue
      }
      if (!best || arrive < best.arrive) best = { drone: d, start, arrive, back }
    }
    if (!best) {
      unassigned.push({ id: p.id, reason: why })
      continue
    }
    free.set(best.drone.id, best.back)
    trips.push({
      drone: best.drone.id,
      start: Math.round(best.start * 100) / 100,
      packages: [p.id]
    })
  }
  trips.sort((a, b) => a.start - b.start || (a.drone < b.drone ? -1 : 1))
  return { trips, unassigned }
}

module.exports = { plan }
