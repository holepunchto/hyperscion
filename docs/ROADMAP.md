# hyperscion roadmap

Where we are and where we're going. Details live in DESIGN.md (architecture, decisions) and
EXPERIMENTS.md (measurements). Milestones run in sequence. Each one ends with its probes (the
scripted tests in `test/`) passing and a quick run (`scripts/experiment`, scenario `q1`) as a
small check with real agents.

## Goals

1. **The original thesis (Scion without a server).** How much of Scion's design can the
   Holepunch stack give us peer to peer?
   - Scion's design: cheap forks, lock-free landing, history that builds on what came before,
     lazy fetch, a cache tier, fast boot from a snapshot, at tens of thousands of changes a day.
   - The question is what we get with no authoritative server, and where we fall short.
2. **The product the experiments found.** A better tool than git for teams of agents
   working in parallel:
   - a feed instead of polling;
   - a land that tests and rebases in one step;
   - clear state (provisional, settled, final);
   - a team that keeps working when any one machine, the hub included, goes away.

## Where we are

| milestone     | what                                                                                                                                  | evidence                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| M1            | core prototype: workspaces as cheap forks, autobee landing with path-level OCC, sparse fetch, mirror and blind peers, CLI, git import | fork 1.3 ms at 100k paths; 500 workspaces from 4 writers converge (DESIGN.md §7) |
| M2            | experiment 1 fixes: no stalls, stale files never landed, union merge, `watch`, `show`, `restore`, `seed --admit`, playbook            | agents rated hs 2/5 → 4/5 against git                                            |
| M3            | review: Ship / Show / Ask                                                                                                             | rarely used by agents so far                                                     |
| M4            | finality: provisional → settled → final                                                                                               | land-state trust 4.8–5.0                                                         |
| M5            | CLI defaults (online by default, `fetch`, `land --check`, …)                                                                          | experiment 3: 4/5 from all five agents, all would choose hs                      |
| round 4       | git control team, 14 runs, scenarios S1–S3                                                                                            | EXPERIMENTS.md "Experiment 4"                                                    |
| after round 4 | feeds as holders, outage and hub-stall signals, correctness fixes, fast feedback loop                                                 | `test/outage.js`, `test/fixes.js`, quick runs q1-hs-1/2                          |

**What the experiments say:**

- **Agents prefer hs and spend less effort.**
  - hs is rated 4/5 every time, git 3/5.
  - hs takes 2–5× fewer calls and needs no polling.
  - Agents report losing a third to a half as many minutes.
- **The product is the same with either tool.** Main is green and acceptance reaches 100%.
  git often finishes sooner, because its origin is local.
- **At 3–5 agents on a small task, hs wins on ergonomics, not outcomes.**
- **The largest waste is duplicated work across agents.** It hits both arms equally, and it's
  conceptual, not per file.

**The gap:** we've tuned a small team on a toy task, where git is "adequate". The scale that
motivated Scion (many writers, high change volume, no server) is where hs's design should beat
git, and it hasn't been exercised since M1's benchmarks.

## Next

### M6: finish the agent team: done

- **Approvals survive merges.** Teammates' changes merged into an approved proposal's files
  on the way to landing keep the approval; paths protected by `/.hsreview` stay pinned to the
  exact content. This is an `apply` rule, so every peer must run the same version.
- **Your land's new number.** `your land #11 is now #14 (reordered when peers met; nothing
lost)` shows on the author's next `status`, `sync`, `fetch`, `land` or `doctor`.
- **`watch --author <handle>`** waits for one teammate's change.
- **Duplication metric.** `outcomes.js` reports `duplicate_implementations` for scenarios with
  a `duplication` pattern.
  - It counted 3 for q1-hs-1, q1-hs-2, q1-git-1 and q1-hs-3, which matches the agents' own
    accounts.
- **Regression suite.** `npm run probes` runs the outage, fixes and review probes in about
  2.5 min with no LLM.
- **Check:** the full suite passes (458 assertions), plus quick run q1-hs-3:
  - 11 lands, 43 calls (3.9 per land), no errors;
  - main green, acceptance at 100% at minute 4.0;
  - change request done 1.0 min after it landed;
  - ratings 4, 4, 4; 0 minutes lost.
- **Not exercised by the agents.** The new behaviours (renumbering, `--author`, merged
  approvals) didn't come up in that run; the probes cover them.
- **Duplication stays at 3.** That's for M8.

### M7: scale (the original thesis)

- **Per-machine daemon:** one store, warm caches, an IPC API for many worktrees and agents on
  one machine.
- **A swarm benchmark:** 50–200 scripted writers landing on hot paths over a testnet,
  measuring:
  - land latency;
  - reorg rate and apply cost per writer;
  - settlement lag;
  - memory.
- **Settlement at scale:** losing the hub for good (removing or replacing indexers), and a
  quorum of indexers instead of all of them.
- **hyperbee2 read amplification and memory:** findings to take upstream (DESIGN.md §8).
- **Check:** the benchmark report, plus one quick run with a few LLM agents alongside a
  scripted swarm.

### M8: the coordination layer

- **Work-in-progress intents vs. the Keet MCP** (DESIGN.md §14). Decide once Keet is
  available.
- **Measure first:** the duplication metric, a no-code NOTES.md intent habit, and only then a
  minimal `hs intent`.
- **Check:** a quick run comparing duplication, time to acceptance and calls per land.

### The next big experiment (after M6–M8)

It should test something git structurally can't do, not more of the same team size.
Candidates:

- **Swarm:** 20+ agents.
- **Partitioned teams:** several sites that are often offline from each other.
- **No always-on server.**
- **A long horizon:** a stream of change requests over hours.

On these, the outcome itself could differ, not just the effort.
