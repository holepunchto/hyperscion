# Change request CR-1 (from pm)

Customers are billed by flight time from now on. This replaces the price formula:

- **price = 2.00 + 0.25 × flight minutes + 0.40 × weightKg**, in EUR;
- **express**: the whole price × 1.5;
- rounded to cents (half up) per package; `total` is the sum of the rounded prices.

**Flight minutes** for a package are the minutes of flight from the moment its drone leaves
the depot until it arrives at that package's stop, along its trip in flight order. Service
and waiting time don't count.

`--json` keeps the shape pinned in CONTRACTS.md (a price per delivered package, and `total`).

Who does what:

- **a3:** implement it in `src/pricing.js`, update the CONTRACTS.md pricing section, the report
  (show each delivery's flight minutes) and the integration test.
- **a2:** make each stop's flight minutes available to pricing if it needs them.

This takes priority over current plans.
