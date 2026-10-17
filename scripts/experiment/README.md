# Multi-agent experiment harness

Five agents build "Skyhop" (a drone-delivery planner, `skeleton/`) in parallel. They
coordinate only through the tool being evaluated: `hs` (the hs arm) or plain `git` against a
shared origin (the git control arm). docs/EXPERIMENTS.md has the rounds and their findings.

## One run

```sh
scripts/experiment/setup.sh <teamdir> <hs|git> <s1|s2|s3>   # team + prompts in <teamdir>/prompts
# start one agent per prompt (a1..a5) in parallel, then immediately:
date -Iseconds > <teamdir>/started.txt
node scripts/experiment/inject.js <teamdir>                  # runs the scenario's schedule
# S3: when inject.js exits (minute 12) stop the a3 agent and start a3b from prompts/a3b.md
# when every agent has written its report:
node scripts/experiment/inject.js <teamdir> --stop            # stop the hub (hs) and feeds
node scripts/experiment/analyze.js <teamdir>                  # tool usage -> metrics.json
node scripts/experiment/outcomes.js <teamdir> scripts/experiment/acceptance/acceptance.js
node scripts/experiment/compare.js <teamdir> <teamdir> ...    # arms and rounds side by side
```

## Fast loop (minutes, not hours)

Use it before a full round. There are two tiers.

1. **Scripted probes (no LLM, about a minute each).**
   - `test/outage.js` and `test/fixes.js` replay what experiment 4's agents ran into on a
     private testnet:
     - the hub going down;
     - a stand-in taking over while it's down;
     - restore, conflict markers, proposal diffs and approvals.
   - `test/helpers/team.js` sets up a hub plus N agents in a few seconds. Write a new probe
     for every new agent complaint before fixing it.
   - Run them with `npx brittle-bare test/outage.js test/fixes.js`.
2. **A quick LLM run.** Scenario `q1`:
   - 3 agents on a smaller split of the same task, about 10 minutes, with a short report.
   - hs runs on a local testnet (`localDht`), so setup takes about 15 s and there's no
     public-DHT latency.
   - The hub or origin is down from minute 2 to 4, and the change request lands at minute 3.
   - One run is about 3 agents × 60–100k tokens, compared with about 500k for a full run.

   ```sh
   scripts/experiment/setup.sh <teamdir> hs q1        # or git
   # start a1..a3 from <teamdir>/prompts, then:
   date -Iseconds > <teamdir>/started.txt
   node scripts/experiment/inject.js <teamdir>
   # when the reports are in: inject.js --stop, analyze.js, outcomes.js, as below
   ```

   `inject.js --scale 0.1` replays a scenario's schedule ten times faster, for dry runs
   without agents.

3. **While fixing a bug, use the shortest tier that shows it.**
   - **Scripted replay of a q2 run (about 70 s, no LLM):** the q2 team, a 20-writer swarm,
     the hub going down, a land made during the outage, and a teammate syncing until it
     arrives.

     ```sh
     scripts/experiment/setup.sh <teamdir> hs q2
     node scripts/experiment/outage-replay.js <teamdir> [--like-q2-hs-5]
     ```

     The last line is a summary: land time, whether a holder took it, when the teammate had
     it, and the land's phases.

   - **Debug logs, the agents never see them:** the wrappers set `HS_DEBUG_LAND` (land and
     sync phase timings) and `HS_DEBUG_MIRROR` (a feed's mirror steps), written to
     `<teamdir>/debug/`.
   - **Short LLM run, `q2s` (about 6 minutes):** q2 with the outage from minute 1 to 2.5,
     the change request at 1.5, and agents told to stop once their module and their part of
     the change request are on main. Run `swarm-load.js --minutes 7` alongside.
   - **A person in the loop, `q2h` (claims phase 2, docs/CLAIMS.md):** q2s where the
     change request lands with a `/.hsreview` that makes `CONTRACTS.md` changes need
     approval from ann, a human writer that `setup.sh` marks with `add-writer --human`. The
     CR is a contract item (a3 leads). `inject.js` starts `approver.js`, a scripted ann who
     approves what `hs inbox` and `hs proposals` show after 10 s, but holds the CR item for
     90 s. Her decisions go to `<teamdir>/approvals.jsonl`, and `alerts.js` prints them
     along with refused lands.
   - **Cut runs short:** `node scripts/experiment/alerts.js <teamdir> --follow` prints one
     line per problem (push timeouts, unfetchable content, stale-copy refusals, stalls,
     lands or syncs over 30 s) and when the change request lands. Stop the agents as soon as
     a run has shown the problem, or that the fix works. Save full q2 runs for when the known
     issues are fixed.

## Pieces

- **Arms:**
  - `scripts/team.sh` sets up the hs arm: a hub running `hs seed` plus writers.
  - `scripts/git-team.sh` sets up the git arm: a bare origin plus clones, with `pull.rebase`,
    autostash, zdiff3 and a `NOTES.md` union merge.
  - Each agent gets a wrapper (`bin/hs-aN` / `bin/git-aN`) that traces every call to
    `<teamdir>/trace.jsonl` in the same shape.
- **Prompts:** `agent-prompt.md` (hs) and `agent-prompt-git.md` (git) share the task, role and
  report. They point at the playbook, `docs/AGENTS.md` or `docs/AGENTS-git.md`. Roles are in
  `roles.json`, and a scenario can override them.
- **Scenarios** (`scenarios/sN/scenario.json`): roles, extra writers (`pm`, `a3b`), a brief
  for the prompt, a skeleton overlay and a schedule of minute-stamped events:
  - `offline` / `online` for one agent;
  - `origin-down` / `origin-up` (the hub's seed, or the origin repository);
  - `kill` (an agent's machine dies);
  - `change-request` (the pm lands a change).
- **Outcomes:** `outcomes.js` replays every state main went through (hs: `hs export`; git: origin's
  reflog). It runs the team's `npm test` and a hidden acceptance suite on
  each state. That gives main health, regressions, time to 50/80/100% acceptance and, in S2,
  how long the change request took. The acceptance suite is in `acceptance/`;
  agent prompts forbid reading this repository. It tests only through the `--json` shape pinned in `skeleton/CONTRACTS.md`.
- **Reports:** each agent writes a candid report with a JSON scorecard to
  `<teamdir>/reports/`, and `analyze.js` aggregates them.
