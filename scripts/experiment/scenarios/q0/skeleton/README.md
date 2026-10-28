# Skyhop — drone delivery planner

Skyhop plans a day of package deliveries for a small fleet of drones operating out of city
depots. Given a day file (depots, drones, packages), it decides which drone carries which
packages in which order, prices every delivery and prints a dispatch report.

```
node src/cli.js plan fixtures/day1.json          # human readable dispatch report
node src/cli.js plan fixtures/day1.json --json   # machine readable plan + prices
npm test                                         # unit + integration tests (node --test)
```

## Modules and owners

Everything below exists and works: `npm test` passes and `node src/cli.js plan fixtures/day1.json`
prints a dispatch report. The team now maintains it.

| module                                                       | owner    |
| ------------------------------------------------------------ | -------- |
| `src/model.js`, `src/geo.js`: day files, distances, travel   | agent a1 |
| `src/scheduler.js`: assign packages to drones, build trips   | agent a2 |
| `src/pricing.js`, `src/report.js`, `src/cli.js`, integration | agent a3 |

Owners may edit other modules when needed; say so in NOTES.md. Interfaces are in CONTRACTS.md.

## Rules of the domain

- Distances are great-circle (haversine) kilometres. Drones fly straight lines at `speedKmh`.
- A trip is depot → stops → depot, within `maxPayloadKg` and `rangeKm`; every stop costs
  `serviceMinutes`. Packages that can't be delivered are unassigned with a reason.
- Prices: see CONTRACTS.md.
