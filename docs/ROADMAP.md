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

**Progress, swarm benchmark (done):** `bench/swarm.js` and `bench/swarm-matrix.sh`; results
in DESIGN.md §7 "Swarm".

- **Shared (daemon) mode:**
  - 200 agents at 6.3 lands/s;
  - land p50 58 ms, settlement p90 under 0.4 s;
  - about 40 MB per agent;
  - every peer converged.
- **Per-agent mode:** degrades by 25 agents (land p90 about 0.9 s, the hub's mirror falls
  behind) and runs out of memory at 50.
- **A constraint found:** two writers of one repo can't share a store, so a daemon is one
  writer per machine.

**Re-scoped (after the swarm benchmark).** On one machine, the realistic count is roughly
5–30 agents, not hundreds:

- inference runs elsewhere (GPU nodes batch many sessions);
- the agent loop is limited by builds and tests;
- hosted agents usually run one sandbox each.

Per-agent mode handles that range (land p50 56 ms at 10). So the daemon doesn't justify its
cost to the P2P model:

- writer identity moves to the machine;
- it conflicts with sandbox isolation;
- it's a new local single point of failure.

It is parked as an option (DESIGN.md §8). M7 now asks the P2P question:

1. **The many-writers benchmark:** 50–200 writers, each its own peer, standing in for a few
   agents per machine across many machines. Settlement, the hub's mirror and per-writer
   replication cost are the likely limits.
2. **A cheaper per-agent model,** with no change to the model:
   - memory per agent (storage caches);
   - a mesh shaped so co-located peers don't all replicate everything;
   - hub mirror throughput.

   Then re-measure 10, 25 and 50 agents per machine.

3. **Settlement at scale: done, with a finding.**
   - **A dead indexer is replaced** by adding a new one and removing the old (`hs remove-writer`).
   - **A quorum is not possible** under autobee's ordering: indexers' concurrent nodes tie on
     weight and fall back to timestamps. `test/settle-indexers.js` shows a majority rule being
     reordered (seed 7); every indexer is still required.
   - **New repos have a light bootstrap writer** (autobee `bootstrapWeight: 1`, carried in the
     invite). `hs init --hub <dir>` makes the hub a separate, removable indexer. With no
     indexer left, settlement waits for every writer (DESIGN.md §11).

**Progress: the cheaper per-agent model (item 2, done).**

- **Storage:** about 2.5 MB per store (`bench/store-mem.js`), so it isn't the cost.
- **The cost was the full mesh.** Peer roles now make a star: agents dial the hub, and feeds
  mesh only during an outage, closing those links once settling resumes (DESIGN.md §7 "Star
  mesh").
- **Per-agent results, before → after:**
  - **25 agents:** land p90 907 → 91 ms; 145 → 81 MB per agent; the hub's mirror keeps up.
  - **50 agents:** previously out of memory; now 199/200 lands, p90 289 ms, 137 MB per agent.
- **What remains scales with the writer count** (each peer applies every writer's ops). Past
  about 50 on one box needs runs across machines.

**Check, first attempt (q2-hs-1): ran, found hub-availability bugs; rerun after fixes.**
Three LLM agents plus pm worked q1's task while a scripted swarm of 20 writers landed under
`/swarm/` (scenario q2, `scripts/experiment/swarm-load.js`). Data:
`docs/experiments/quick/q2-hs-1`.

- **The swarm itself was fine:** 375/375 lands, p50 17 ms, p90 46 ms, 2.2 GB for 20 writers.
- **Outcome was fine:** main 100% green throughout, acceptance 100%, no regressions.
- **The hub's mirror is the headline bug.** It mirrors changesets in order and stops at the
  first it can't fetch. For a changeset's blobs it fetches the blobs core's _current_ length,
  not the length at land time, so an author who commits again and then goes offline blocks
  that changeset, and every later one, for good. The mirror's watermark is also only in memory,
  so a restarted hub re-mirrors from #1 and hits this again.
  - In the run the mirror stopped at #375, so #376–#381 (the change request and every CR-1
    implementation) were held only by their authors. Scoring needed the authors' watches
    restarted.
  - Before the outage the hub was already behind (mirrored #62 while main was at #66+), so
    a1's #66 was not on the hub when it went down, and a2 and a3 couldn't fetch it for minutes
    while a1's feed was up. Not yet explained; a crowded fallback topic (24 feeds) is one
    candidate.
  - Why #376 stalled while the hub was up is not pinned: a land from a worktree with no watch
    does reach the hub in a small repro.
- **A busy main costs agents a lot** (vs q1-hs: about 5 min, land p50 2–10 s, 0–2 min lost):
  18.6 min, land p50 58 s / p90 122 s, 17 min lost, ratings 4/3/3 (1/3 would choose hs).
  - `land --check` re-runs on every unrelated `/swarm/` land and never converged for a3.
  - Read-only commands (`status`, `show`, `doctor`) are locked out while a land runs, with a
    misleading "hs seed running here" hint.
  - `sync` folds teammates' lands into "… and 220 later", hidden by swarm noise.
  - `push` timing out while `doctor` says a holder is online.
- **Not comparable with q1:** the injector failed to land the change request (pm's NOTES.md
  was stale after an outage sync) and it was landed by hand at minute 13.9. So CR timing and
  the duplicate count (2, vs 3 in q1) say nothing yet. Injector fixed (async tool calls,
  restore and resync on a stale copy), untested until the rerun.
- **Hub mirror fixed (done):** blobs held up to the length recorded in the land op (schema
  v10), skip and retry instead of stopping at the first unfetchable changeset, and the
  watermark persisted up to settled (DESIGN.md §11 "The mirror stuck behind one changeset";
  probe in `test/net.js`).

**Check, second attempt (q2-hs-2): the hub holds up; a busy main is slow for agents.** Data:
`docs/experiments/quick/q2-hs-2`.

- **Fixed and confirmed:**
  - the hub mirrored every changeset (#447), and scoring read every state from the stopped hub;
  - the injector restarted the hub on time and landed the change request on its first try.
- **Outcome:** main 100% green, acceptance 100% at minute 12.8 (q1: about 4), ratings
  3/3/4. Duplicate CR-1 implementations: 3, as in q1.
- **The cost is `settle`, not the checks.** Every `sync` took about 30 s, even "up to date",
  and every `land --check` about 243 s: four 0.3 s checks with about 60 s between them.
  `Network.settle` waits for 300 ms of quiet across every writer, capped at 30 s. A polling
  round can take up to 2 s, and the swarm lands about every 1.6 s, so it never sees quiet and
  always pays the cap.
- **Next:**
  - `settle` catches up to what peers held when it started, instead of waiting for quiet
    (done: probe in `test/net.js`; the old rule times out on it);
  - `--check` re-runs only when main changed what the check can see: the land's paths, or
    the sparse checkout minus paths marked `-check` in `/.hsattributes` (done:
    `test/check.js`; q2 marks `/swarm/ -check`);
  - read-only commands during a land (done: they open the store read-only, offline;
    `test/check.js`);
  - teammates first in `sync` (done: busy directories fold into one line; `test/incoming.js`);
  - found on the way: `hs push` can time out after offline lands. First read as stale peer
    state; it turned out the hub really lacked the middle of the writer's oplog (fixed after
    q2-hs-3: mirrors hold every oplog);
  - then a third q2 run.

**Check, third attempt (q2-hs-3): a busy main no longer slows agents; the outage still does.**
Data: `docs/experiments/quick/q2-hs-3`.

- **Busy main, fixed:** land p50 10 s / p90 19 s (243 s in q2-hs-2), normal syncs 1–8 s
  (about 30 s). `--check` landed on the checked state past `/swarm/` lands, and the swarm
  folded into one line in incoming lists. Acceptance 100% at minute 9.3 (12.8). Ratings
  4/4/4, and all three would choose hs (1 of 3 before). 7 minutes lost (14).
- **Remaining, the outage with a swarm:**
  - a2 landed #94 just after the hub went down. Its push timed out ("no holder has your
    changes yet"): no teammate's feed took the content within 30 s, so it stayed on a2's
    machine until a2's next land, 5.6 minutes later. a1's and a3's syncs spent 75–122 s
    each failing to fetch it.
  - **Fixed** (DESIGN.md §7 "Star mesh"; probe `test/outage-swarm.js`): feeds dropped
    their outage links in the first 20 s of every outage, and mirrored changesets one at a
    time, oldest first, behind the swarm's backlog. Now a feed holds a teammate's outage land
    about 0.5 s after it lands (was 9–14 s, or never).
  - **Fixed:** `land` no longer waits 10 s for a settle while no hub is reachable (outage
    land about 1 s, 7 s with the swarm).
  - **Fixed, the `hs push` timeouts:** the peer view wasn't stale. The hub applied a writer's
    lands through the view cores without fetching the middle of the writer's oplog, so no
    holder really had it. Mirrors now hold every writer's oplog (push 0.8 s, was a 30 s
    timeout).
  - **Fixed, the late change request** (minute 7.5): pm's land was refused for "edited on
    top of a stale copy" on a `/swarm/` file pm never touched. The injector had killed a
    sync stuck in the outage (120 s) after it wrote the fetched file but before it saved the
    stat cache. `status` now treats a stale file with main's content (or unchanged
    content) as not edited (`test/stale.js`).

**Check, fourth attempt (q2-hs-4): the change request was lost in the outage.** Data:
`docs/experiments/quick/q2-hs-4`.

- pm landed the change request as #95 during the outage. Its push timed out, and pm, which
  has no `hs watch`, exited, so nobody held its content. The agents never read it,
  acceptance stopped at 92.6%, and their NOTES.md stayed stale (lands touching it refused).
  Ratings 4/3/2, 22 minutes lost.
- **Root cause, on pm's worktree:** no peer ever opened pm's oplog. autobee opens only the
  writers it is linearizing, and peers had applied pm's single land through the view cores.
  So nothing replicated pm's oplog, and push waited for a holder that couldn't come. The
  mirror now opens every writer's oplog by key (`Repo.writerKeys`) and keeps the sessions
  open. Against the restarted hub, pm's push: timeout → 0.7 s.
- **And:** a push that succeeded then hung on exit ("stalled"). `saveBase` read main's event
  count after the network had closed; it now reads local only.
- **No synthetic probe yet:** in-process and CLI setups kept autobee opening the writer, so
  the fix is verified on the real worktree only. A fifth q2 run is the check.

**Check, fifth attempt (q2-hs-5): the outage gap is still open.** Data:
`docs/experiments/quick/q2-hs-5`.

- Acceptance 100% at minute 17.9 (9.3 in q2-hs-3). Ratings 3/4/3, 18 minutes lost. The
  change request landed late again (minute 8.5).
- a2 landed #80 with the hub down. All three feeds showed it within a second, a2's own
  included, but none held its content within push's 30 s. It stayed unfetchable for
  minutes after the hub came back, blocking a3 (~10 min) and pm (stale NOTES.md).
  `test/outage-swarm.js` does not reproduce this: there, feeds hold an outage land in about
  0.5 s.
- **Likely, not verified:** a feed's mirror pass works on view cores (one at a time, up to
  10 s each) and oplogs after its changesets. During an outage that is slow, and a land
  arriving mid-pass waits for the pass to end. The probe's feeds may never hit the slow path.
- **Measured (scripted replay, `scripts/experiment/outage-replay.js`, about 70 s):** mirror
  passes take milliseconds; that guess was wrong. A replay of a2's q2-hs-5 sequence
  instead stalled about 30 s _before_ the land op, inside `settle`. A writer whose oplog no
  connected peer had never got a target, so every settle on a busy main ran to its
  timeout. Fixed: after one round of asking, such a writer's target is what we hold. Also,
  `land --check` no longer re-pulls when no peer is connected (solo or offline: 19 s → 4 s).
  The replayed outage land: 31.8 s → 1.6–2.3 s, and a teammate has it 4 s later.
- **Explained by the first short run (q2s-hs-1), and fixed:** the q2-hs-5 failure, where the
  land op went out at once and every feed saw it but none held it. From the outage start,
  each feed's mirror tried one swarm changeset every 10 s: the content was unreachable and
  each attempt timed out after 10 s. It went newest first, with a single worker left,
  because the others returned when nothing was pending at the start of the pass. A
  teammate's land was never the newest, so it was never tried. Now four long-lived
  workers, 3 s attempts, backoff for what fails, and view cores, oplogs and proposals in
  their own pass. Probe in `test/net.js`: a fresh land is held after 2.6 s (9.6 s before)
  while six older changesets are unreachable. Still open: why the swarm's content was
  unreachable during that outage (fetched in about 1 s in `test/outage-swarm.js`), and two
  `land`s that exited "stalled" within 200 ms.
- **Turnaround:** scripted replay (~70 s), short LLM scenario `q2s` (~6 minutes), and
  `alerts.js` to cut a run short (`scripts/experiment/README.md`, "Fast loop").

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
