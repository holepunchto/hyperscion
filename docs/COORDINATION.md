# Coordination: what hs keeps (decision, October 2026)

The retrospective of October 2026 asked whether hs-native coordination (claims, items,
leads, signals, and the review layer) beats a task board kept over the same change-control
core, and whether a minimal surface does as well as the full one. Runs are in
docs/experiments/quick/RUNLOG.md (q0, q0b, q0bo, q2s-plain).

## Decision

**Keep the claims mechanism; shrink its surface.** Agents are taught one primitive: `hs claims`,
`hs claim <item>` (an atomic, first-wins claim with a verdict, settled by signals even while
the hub is down), `--release`, `--done`, and lands that link themselves to the item they lead.
Items, parts, co-leads, `--with`, `--take`, `--note` and the people-facing approval commands
stay in hs but leave the agent playbook (docs/CLAIMS.md documents them). No new flags until a
flow test (`npm run flows`) or a q0-style run shows the need.

## Evidence

| scenario                                  | arms                         | built                                                 | what differed                                                                                                                                                           |
| ----------------------------------------- | ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| q0 (obvious owner)                        | full, minimal, board         | once in all                                           | nothing on outcomes; the board used fewer calls                                                                                                                         |
| q0b (no owners, a race)                   | full, minimal, board         | once in all                                           | claims settled a 0.2 s race in one call; the board needed withdraw lands and all three agents asked for an atomic claim                                                 |
| q2s (outage, swarm; the CR assigns work)  | board vs earlier claims runs | twice in all (the CR tells two agents to build parts) | nothing on outcomes                                                                                                                                                     |
| q0bo (no owners, claims during an outage) | minimal, board               | once in both                                          | the claim resolved the race peer-to-peer in one call; the board needed 6 coordination lands and all three agents asked for an atomic claim with an order peers agree on |

- **Outcomes** (duplication, time to acceptance, ratings) matched across all arms in every
  scenario: these agents coordinate through whatever is there.
- **The full surface never beat the minimal one** (q0, q0b): nothing an agent did with items,
  parts or co-leads changed an outcome.
- **Cost:** once a task board's claim and withdraw lands are counted as coordination (they
  are round trips), the board is 1.2-1.5x cheaper per code land on easy days, not 3x.
- **The primitive is what agents want:** every board arm hit the race claims resolve, and its
  agents asked for an atomic first-wins claim by name, three times, once specifically for an
  order that holds while the hub is down.

## Limits of this evidence

- One run per arm per scenario; outcomes are within the noise floor everywhere.
- No run ever undid a TASKS.md claim (the outages were short and feeds stayed up), so the
  case where a board claim is lost is still untested.
- The agents are one model family on one small task.

## Next

- Cut the claim round trips agents still pay: a claim's verdict when the lead changes (feed
  line), the board in `sync` output, `hs claim` exiting non-zero when someone else leads.
- A longer partitioned run (hours, sites, a lost claim) before revisiting the board question.
