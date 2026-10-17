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
- **Partitions (q0bp):** an agent cut off just after the change request arrived duplicated the
  work in both arms: a claim that reaches nobody coordinates nothing, like a board line.
  Claims now say so (`nobody heard this claim`, exit 2) instead of "you lead", so an agent
  that reads it waits to claim again rather than building blind.
- No LLM run ever undid a TASKS.md claim (the outages were short and feeds stayed up). The
  scripted flow F9 (test/flows.js) covers the partition case: two agents claim the same item,
  and put a claim line on the board, while they can't see each other; when they meet, the
  claim has one lead by the same rule on every peer (exit 0 for the lead, 2 for the other),
  and the board keeps both lines with nothing to say who holds it.
- The agents are one model family on one small task.

## Next

- Done: `hs claim` exits 2 when someone else leads; the feed's claim line names who leads;
  `sync` lists the open items and their leads. The q0b minimal-arm rerun (q0b-min-2) halved
  coordination calls (18 to 10) and brought calls per code land from 37 to 32, against 24
  for a task board, with the same outcome.
- Done: the minimal surface keeps `hs review #n`, and the playbook points non-leads at it.
  q0b-min-3: reviews moved from NOTES.md lands into review records (coordination lands 3 to
  0; calls per code land 32 to 30).
- Done: `hs claim <item> --if-free` withdraws a losing claim at once; `hs land --done` closes
  the item the land links itself to. Both in test/flows.js (F1, F10).
- Multi-site: q0bs splits the team into two sites, each with peers (the hub on one side),
  for 4.8 minutes. Claim leases last 20 minutes and renew while held, so the lead rule a
  longer split exercises is the same one. Covered by test/flows.js F11 and LLM runs
  q0bs-min-1/2.
  - In q0bs-min-2, each side had its own lead (a2 on B at 0.52, a3 on A at 0.54), and each
    built the change request. On heal the earlier claim led everywhere, which is the claims
    mechanism working as designed.
  - That run found a core bug that isn't about claims: in `init --hub` repos a land the hub
    made final could be reordered by the site that couldn't reach it. Fixed (docs/FINALITY.md).
  - On the fixed core, claims (q0bs-min-3) and board (q0bs-plain-1) ended the same: built
    on both sides, finality held, 3,3,4 and 1/3 choose in both. Neither mechanism can
    coordinate sites that can't hear each other; the low ratings were about the heal (an
    earlier undone land lost, advice to re-land a duplicate), both fixed.
  - Decision unchanged: keep claims. A split is no argument either way; races (q0, q0b, q0bo)
    are where claims beat the board, and the board's agents asked for claims each time.
