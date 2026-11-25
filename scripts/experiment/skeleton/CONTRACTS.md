# Contracts

Rough sketch. Each owner pins down their section **in the same changeset** as the code, so
others can rely on it. Until then, treat these as guesses.

## model (a1)

- `loadDay(json) -> Day` — validates and normalizes a day file. Shape of `Day`: TBD.
- Validation errors: TBD (throw? collect?).

## geo (a2)

- `distanceKm(a, b)` where a/b are `{ lat, lon }`.
- Route ordering for a set of stops: TBD.

## scheduler (a3)

- `plan(day) -> Plan`. Shape of `Plan`: TBD. Must include unassigned packages with reasons.

## pricing / report (a4)

- Price formula: TBD (base fee + per km + weight + express surcharge?).
- `price(plan, day)`, `renderReport(plan, prices, day)`: TBD.

## cli (a5)

- `plan <dayfile> [--json]`. Exit 0 on success; a non-zero exit with a message on stderr for
  an invalid day file.
- **Pinned now (operations' tools read it):** `--json` prints one JSON object with at least

  ```json
  {
    "trips": [{ "drone": "d1", "start": 0, "packages": ["p03", "p07"] }],
    "unassigned": [{ "id": "p19", "reason": "too heavy for every drone" }],
    "prices": { "p03": 7.4, "p07": 9.15 },
    "total": 16.55
  }
  ```

  - `trips`: every trip; `start` is the minute (after the day starts) the drone leaves its
    depot, `packages` lists the stops in flight order.
  - `unassigned`: every package not delivered, with a reason.
  - `prices`: the price of every delivered package; `total` is their sum.
  - More fields are fine.
