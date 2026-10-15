# Multi-agent experiments

**Setup** (same in both runs):

- 5 AI agents (a1 model, a2 geo, a3 scheduler, a4 pricing/report, a5 cli/integration) build
  "Skyhop", a drone-delivery planner, in parallel.
- Agents coordinate **only** through `hs` over the public DHT. A hub runs `hs seed --mirror`.
- No git. No reading other agents' worktrees.
- Every `hs` call is traced, and each agent writes a candid report with a scorecard.

The harness is in `scripts/experiment/` (see its README) and `scripts/team.sh`.

**Limits:** these are single runs, with no git control team, and the agents know git much
better than hs.

## Results side by side

|                                                        | experiment 1 (milestone 1)                        | experiment 2 (milestone 2)                  |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| usefulness vs git (1–5, all five agents)               | **2, 2, 2, 2, 2**                                 | **4, 4, 4, 4, 4**                           |
| would choose hs over git for this                      | 0 / 5                                             | 5 / 5                                       |
| product on main                                        | 26 changesets, 63/63 tests, CLI works             | 27 changesets, 61/61 tests, CLI works       |
| hs calls                                               | 654                                               | 129                                         |
| `pull` calls (polling)                                 | 262 (one agent: 111)                              | **0**: agents used `hs watch`               |
| content stalls ("stalled waiting for data")            | 30–77 per agent transcript, 8–10 min blocked each | **0**                                       |
| near-silent reverts (stale files shown as edits)       | 3 agents hit it, caught by hand                   | **0** (stale files are never edits)         |
| lands undone by a reorg                                | 1, nobody told                                    | 0 happened (banner and restore are tested)  |
| land rejections                                        | 13 (plus 1 stale-base)                            | 10 auto-rebased and landed, 1 real conflict |
| NOTES.md conflict markers                              | every concurrent append                           | **0** (union merge)                         |
| times a teammate's landed work changed an agent's plan | 24                                                | 23                                          |

Both runs built working software. What changed is the friction. In experiment 1, agents spent
much of their time on stalls, polling and checking for reverts. In experiment 2:

- they watched a feed;
- they landed in one command that rebased itself;
- they read teammates' changes as diffs (`hs show`);
- they waited on dependencies with `hs watch --path <file> --count 1`.

## Experiment 3 (milestones 3–5: review, finality, CLI defaults)

Same setup and task, on the public DHT. `scripts/experiment/analyze.js` now writes
`metrics.json`, and `compare.js` puts rounds side by side:

|                                   | exp 2         | exp 3         |
| --------------------------------- | ------------- | ------------- |
| usefulness vs git                 | 4, 4, 4, 4, 4 | 4, 4, 4, 4, 4 |
| would choose hs                   | 5/5           | 5/5           |
| hs calls / minutes                | 129 / 23.9    | 100 / 18.2    |
| calls per accepted land           | 4.96          | **3.7**       |
| lands accepted / attempted        | 26 / 27       | **27 / 27**   |
| real conflicts                    | 1             | **0**         |
| lands that ended final            | n/a           | **27 / 27**   |
| land p50 / p90                    | 2.6 s / 2.9 s | 2.8 s / 3.2 s |
| `-o` / `pull` (old habits)        | 27            | **0**         |
| output clarity (1–5)              | n/a           | 4.2           |
| knew when a land was safe (1–5)   | n/a           | 4.8           |
| confusing messages / minutes lost | n/a           | 7 / 12        |
| proposals / reviews / Shows       | 0 / 0 / 0     | 0 / 0 / 0     |

The product: 28 changesets, 69/69 tests from a fresh clone, and the CLI plans 18/19 packages.

**Why the rating stayed at 4.** Nothing went wrong. Every agent said, in one form or another,
that this task is well partitioned (one owner per file, append-only shared files), so git with
a union attribute and `pull --rebase` would be "about 80% as good". hs's differentiators never
came into play:

- no lands were reordered, so finality only showed `final`;
- nobody touched another owner's files, so review was never triggered;
- the hub never went down, so availability was never tested.

The task design caps the score, not the tool.

**What experiment 3 found:**

1. **Lands publish merged states nobody tested (4/5 agents; the most-wanted feature for 3).**
   `land` rebases onto teammates' changes and publishes immediately. Wanted: `land --check
"npm test"`, which runs on the rebased tree and refuses to land if it fails.
2. **`watch --count` counts `settled` events (2/5; a bug).** Without `--path`, a watch exited
   on `@ settled through #n` lines without printing the changesets.
3. **The incoming list hides the oldest entry** behind `... and 1 earlier (hs log -f)`, which
   also names a flag that is now hidden.
4. **`log --oneline` prints two lines**, and **`log`/`status` don't say how far behind main
   you are**.
5. **Smaller requests:**
   - `show <n> --path <p>`;
   - `watch --path` with globs or several paths;
   - "changeset(s)" wording in `--for-me` timeouts;
   - exit 2 is overloaded for watch timeouts;
   - an amend for your own provisional land.

## What experiment 2 still found

Each item is ranked by how many agents raised it.

1. **Clean auto-rebases print "conflict on N path(s)" (4/5 agents).** It reads as an error even
   though the land then goes through. It should read as information ("main moved, rebasing
   onto it…").
2. **Lands never stop being "provisional" (4/5).** `status` says provisional long after later
   lands are on top. Agents want an explicit "final" signal. This is the finality item in
   DESIGN.md §8.1, now a real user request.
3. **`watch --count 1` can wait on something that already happened (3/5).** a5 blocked for
   500 s on a file that had already landed. `--since <seq>` exists but the playbook didn't say
   to use it. Needed: `--since` defaulting to the workspace base when `--path` is given, and a
   `--timeout`.
4. **Stopping your own watcher is unsafe (4/5).** a1 ran `pkill -f "bin.mjs watch"` and killed
   every agent's feed, because the process command line doesn't identify the agent. Restarted
   feeds don't backfill what they missed. Needed: `hs watch --stop` (pidfile in `.hs/`), and
   feeds that resume from the last seq they printed.
5. **`sync`/`land` don't say what came in (3/5).** Wanted: a one-line summary of incoming
   changesets (`#18 a4 report.js`, …). "replayed" in sync output is unclear.
6. **No review step (2/5).** a4's wrong guess at the Plan shape (#8) was fixed in parallel by
   three agents (#13, #15, #18), which left redundant code and caused the one real conflict.
   Ideas: a `hs propose` that shares a workspace for review before landing, or feed mentions
   (`watch --mentions a3`).
7. **Small things:**
   - `log -f <path>` lists every file in each matching changeset;
   - conflict markers don't name the changeset or author.

**Status after the follow-up:**

- Done: items 1 (rebase wording now names who changed what), 3 (waits start from your synced base, `--timeout`), 4 (`hs watch --stop`, feeds resume) and 5 (`sync`/`land` list incoming changesets).
- Item 6 (review) is addressed by Ship / Show / Ask: owner-default Show, proposals with quorum approvals, and opt-in `/.hsreview` rules (DESIGN.md §10). It has not been tried in an experiment yet.
- Item 2 (finality) is addressed by milestone 4: lands go provisional → settled (the hub has acked) → final (settled and accepted by review); `land --wait-final`, `status`, `log` tags and `watch --for-me` show it (DESIGN.md §11). Not yet tried in an experiment.
- `test/cli.js` covers them through the real `hs` binary and runs by default. Its earlier failures were loopback connectivity, now fixed (DESIGN.md, connectivity notes).

## Experiment 1 findings and their fixes (milestone 2)

See DESIGN.md §9. In short:

- `pull` prefetches the sparse set;
- reads time out instead of stalling;
- stale files are never edits;
- `land -o` waits until a holder has the content, and auto-rebases;
- union merge via `.hsattributes`;
- flip banners;
- `hs watch`, `hs show` and `hs restore`;
- `seed --admit` and `scripts/team.sh`;
- the `docs/AGENTS.md` playbook.

One of these was found while building the fixes rather than by the agents. `land -o` used to
exit before the hub mirror had downloaded the land's content, which left it only on the
author's machine. That is likely the root cause of many of experiment 1's stalls.
