# Coordination: what hs keeps (decision note, in progress)

This note records what the retrospective of October 2026 set out to decide, and where the
evidence stands. Details per run are in docs/experiments/quick/RUNLOG.md; the plan is the
q0 three-arm experiment there.

## The question

Does hs-native coordination (claims: items, leads, signals; the review layer) beat a task
board kept over the same change-control core, and is the minimal surface as good as the full
one?

- If a task board does as well: hs shrinks to the substrate (records, signals, apply policy)
  and exposes it to agent teams or Keet.
- If hs wins: keep it, and make the minimal surface the default for agents.

## Evidence so far

- **Usage (13 runs before q0):** agents rarely misuse the CLI (2 unknown flags in about 790
  calls). The cost of coordination is round trips: calls per land went from 4.5 at M7 to
  about 10 in the q2h runs, and coordination is 20-44% of calls in the claims era.
- **Claims under stress (q2s-claims, q2h, q2-hs-7):** duplicates fell from 3 to 2 (and 1 in
  q2h-1), the change request's lead held, and signals reached teammates within seconds while
  the hub was down, where a landed file moves at land speed and can be undone.
- **q0 round 1 (easy day, no outage, obvious owner):** all three arms built the change once,
  equally fast; the task board did it with 0 coordination calls and 40% fewer calls per land.
  The scenario created no contention, so it can't separate the arms on duplication.

## Current reading

- The minimal surface (B) cost the same as the full one (A) and lost nothing. Agents don't
  reach for the extra features; the surface can shrink without harm.
- On an easy day a task board is cheaper than claims. Claims have to earn their round trips
  where files can't: ownership in doubt, outages, many writers.
- Next: q0 with genuinely unclear ownership, and a task-board arm under q2s's outage and
  swarm. Read results only past the noise floor (duplicates differ by 2 or more, or
  coordination calls by 2x or more).
