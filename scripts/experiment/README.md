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
