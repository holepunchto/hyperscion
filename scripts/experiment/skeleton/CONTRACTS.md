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

- `plan <dayfile> [--json]`.
