# Contracts

## model, geo (a1)

- `loadDay(file) -> Day`: reads and validates a day file; throws `DayError` with a message.
  `Day` is `{ serviceMinutes, dayLengthMinutes, depots, drones, packages }` as in the file.
- `distanceKm(a, b)` for `{ lat, lon }` points (haversine); `travelMinutes(km, speedKmh)`.

## scheduler (a2)

- `plan(day) -> { trips, unassigned }`: `trips` is `[{ drone, start, packages: [id] }]`
  (`start` in minutes after the day starts; one package per trip today), `unassigned` is
  `[{ id, reason }]`.

## pricing, report, cli (a3)

- `price(plan, day) -> { prices: { id: EUR }, total }`: 2.00 + 0.50 per km flown to the stop
  - 0.40 per kg, express × 1.5, rounded to cents per package; `total` is the sum.
- `renderReport(plan, priced) -> string`.
- `node src/cli.js plan <day> [--json]`: `--json` prints `{ trips, unassigned, prices, total }`.
