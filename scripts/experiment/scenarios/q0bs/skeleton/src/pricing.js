// Prices: 2.00 EUR + 0.50 per km to the stop + 0.40 per kg; express x1.5; cents
const { distanceKm } = require('./geo')

function price(plan, day) {
  const pkg = new Map(day.packages.map((p) => [p.id, p]))
  const drone = new Map(day.drones.map((d) => [d.id, d]))
  const depot = new Map(day.depots.map((d) => [d.id, d]))
  const prices = {}
  for (const t of plan.trips) {
    let at = depot.get(drone.get(t.drone).depot)
    let km = 0
    for (const id of t.packages) {
      const p = pkg.get(id)
      km += distanceKm(at, p.destination)
      at = p.destination
      let eur = 2 + 0.5 * km + 0.4 * p.weightKg
      if (p.priority === 'express') eur *= 1.5
      prices[id] = Math.round(eur * 100) / 100
    }
  }
  const total = Math.round(Object.values(prices).reduce((a, b) => a + b, 0) * 100) / 100
  return { prices, total }
}

module.exports = { price }
