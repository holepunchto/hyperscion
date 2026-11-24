# Wins

Moments from experiment runs where hs changed the outcome: things that would have gone wrong
without it, or went wrong in the run that didn't have it. Each one names the runs it comes
from, so you can read the traces. These are illustrations, not benchmarks: most are a single
run per arm. [EXPERIMENTS.md](EXPERIMENTS.md) and the
[run log](experiments/quick/RUNLOG.md) have the full record, including the runs where hs
didn't help.

## The check gate caught what a large model's review let through

**November 2026 · runs `q0m-hs-1` and `q0m-nogate-1` · [docs/CHECKS.md](CHECKS.md)**

**The setup:** a large model (Opus) leads two small models (Haiku). The lead splits a change
request into pieces, hands them out, and reviews what comes back. This is the shape of
delegation: the large model writes specs and reviews; the cheaper ones write the code. The
change request is pricing v2 for a drone-delivery planner. It has details small models
tend to miss, and it changes the `--json` output that `CONTRACTS.md` pins.

The same team, the same model mix and the same change request ran twice:

|                           | with the gate                            | without it                                                   |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| what the repo declared    | `/.hschecks`: `test`, `contracts`        | nothing; the prompt says "verify your work"                  |
| main broke its contract   | never                                    | **for 3.4 minutes**                                          |
| bad lands stopped         | a worker fixed 2 failures before landing | none: the drift landed                                       |
| the lead's review         | read both lands, approved both           | approved the broken land ~10 s after it landed, no `hs show` |
| "I knew my land was safe" | 5 / 5                                    | 4 / 5 (one worker: 3)                                        |

**What happened without the gate.** A small worker changed `price()` to also return flight
minutes. The cli passes `price()`'s result straight into `--json`, so the output gained a
key that `CONTRACTS.md` didn't pin. `npm test` still passed, so the worker landed. The lead
approved it about ten seconds later, without looking at it through `hs show` (the trace
records only hs calls, so it may have read the files another way; either way it missed the
drift). Main stayed out of contract until the other worker's piece happened to update
`CONTRACTS.md`, three minutes later.

**What happened with it.** The repo's `contracts` check runs on every land that touches
`src/` or `CONTRACTS.md`, and `/.hsreview` makes every peer refuse a land into those paths
that didn't pass it. A land like that one stops with the exact mismatch:

```
!! not landed: check contracts failed (exit 1, 0.1s) on main #2 + your changes
  | contracts: --json prints { minutes, prices, total, trips, unassigned } but CONTRACTS.md pins { prices, total, trips, unassigned }
```

In the gated run, the small workers ran `hs check` before landing without being told to.
One saw its own new test fail twice, fixed it, and landed clean on the third try.
The lead read both lands and approved them, and every land carried a record of the checks it
passed, visible in `hs log` and `hs show`.

**Why it matters.** Strong agents test their own work, and hard-coding `npm test` into
every prompt adds little ([an earlier run](experiments/quick/RUNLOG.md) showed no
difference). The gate earns its keep when the work is delegated. The small models make the
mistakes, the big model's review is fast and trusting, and the check is the one reviewer that
reads every land. The repo, not the prompt, says what "verified" means, and hs enforces it
at the land for every peer.

## A fair start turned a three-way race for a task into one claim

**November 2026 · runs `q0b-v031-1` and `q0b-v032-1` · [docs/TASKS.md](TASKS.md#starting-one)**

**The setup:** three agents and no module owners. A change request lands, and anyone could
build it, so all three reach for it at once.

**Before (0.3.1):** all three ran `hs task start` within 0.7 s. The claim rule settled it
correctly: one lead, and nothing built twice. But two agents had claimed and lost. Each had to
`hs task stop`, land a NOTES.md line to say so, and one rated the lost race as confusing ("it
was unclear whether I still held a claim").

**After (0.3.2):** `task start` waits its turn first: a share of a ~4 s window set by the
distance between the writer's key and the task id, so each task orders the writers
differently. The turns came out 1.2 s, 2.2 s and 3.0 s. The first agent claimed. The other two
saw its start arrive while they waited, made no claim, and were told so:

```
fair start: waiting 2.2 s in case a teammate closer to Ta4dc47 starts it first
a2 leads Ta4dc47
  you're not on it: they started it while you waited your turn, so no claim of yours was made
```

|                             | 0.3.1 (race) | 0.3.2 (fair start) |
| --------------------------- | ------------ | ------------------ |
| claims made on the task     | 3            | 1                  |
| `task stop` to clean up     | 2            | 0                  |
| confusing messages reported | 1            | 0                  |
| output clarity (1–5, mean)  | 4.33         | 4.67               |
| coordination calls          | 13           | 12                 |

**What it didn't change:** the outcome. Both runs built the change request once, kept main
green and finished at the same minute. The agents still rated hs 4/5: their remaining ask is to
register as the task's reviewer instead of saying so in NOTES.md. The win is that a race that
happens on every unowned task, the commonest case in a team of agents, stopped producing
claims to take back.
