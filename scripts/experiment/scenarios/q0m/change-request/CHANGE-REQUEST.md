# Change request CR-2 (from pm)

Pricing v2 replaces the price formula. For each delivered package, in this order:

1. **base** = 2.00 + 0.25 × flight minutes
2. **weight**: + 0.40 per kg for the first 2 kg, + 1.00 per kg above 2 kg
3. **minimum**: a price below 4.00 becomes 4.00
4. **express**: × 1.5
5. **rush hour**: + 1.00 when the package's trip leaves the depot before minute 60
   (`start < 60`); this is added after express, never multiplied
6. round to cents (half up); `total` is the sum of the rounded prices

**Flight minutes** for a package are the minutes of flight from the moment its drone leaves
the depot until it arrives at that package's stop, along its trip in flight order. Service and
waiting time don't count.

Worked examples (flight minutes, kg, priority, trip start → price):

| min | kg  | priority | start | price |
| --- | --- | -------- | ----- | ----- |
| 12  | 1.5 | standard | 75    | 5.60  |
| 4   | 1   | standard | 90    | 4.00  |
| 10  | 3.5 | express  | 20    | 11.20 |
| 3   | 0.5 | express  | 45    | 7.00  |

**Output:**

- `--json` gains `minutes`: `{ id: flight minutes }` for every delivered package, rounded to
  one decimal: `{ trips, unassigned, prices, minutes, total }`.
- The report line shows them: `d1 start 0.0 min  p1  12.3 flight min  5.60 EUR`.
- CONTRACTS.md says all of this (the formula and the `--json` shape).

This takes priority over current plans.
