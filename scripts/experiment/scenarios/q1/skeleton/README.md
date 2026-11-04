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

| module                                                       | owner    | depends on |
| ------------------------------------------------------------ | -------- | ---------- |
| `src/model.js`, `src/geo.js` — day files, distances, travel  | agent a1 | —          |
| `src/scheduler.js` — assign packages to drones, build routes | agent a2 | model, geo |
| `src/pricing.js`, `src/report.js`, `src/cli.js`, integration | agent a3 | everything |

Owners may edit other modules when needed, but say so in NOTES.md.

## Rules of the domain

- Distances are great-circle (haversine) kilometres. Drones fly straight lines.
- A drone starts and ends its day at its home depot. One trip = depot → stops → depot.
- A drone has `maxPayloadKg` per trip and `rangeKm` per trip (battery); it is recharged at
  the depot between trips. Drones may make several trips per day.
- A drone flies at `speedKmh`; every stop costs `serviceMinutes` (from the day file).
- Packages have a weight, a destination, a priority (`standard` | `express`) and an optional
  delivery window `[earliest, latest]` in minutes after the day starts.
- A package that cannot be delivered (too heavy for every drone, out of range, impossible
  window) must be reported as unassigned **with a reason**, never silently dropped.
- Prices: see CONTRACTS.md (owned by a4, to be pinned down).

## Done means

- `npm test` passes, including an integration test over `fixtures/day1.json` and at least
  one edge-case fixture.
- `node src/cli.js plan fixtures/day1.json` prints a sensible report.
- CONTRACTS.md describes the interfaces that actually exist.
