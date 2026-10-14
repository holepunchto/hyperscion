# Multi-agent experiment harness

Five agents build "Skyhop" (a drone-delivery planner, `skeleton/`) in parallel, coordinating
only through `hs`. The point is to observe whether agents find hyperscion useful for watching
and building on each other's work.

```sh
scripts/team.sh <teamdir> 5 --skeleton scripts/experiment/skeleton   # hub (holder) + a1..a5
date -Iseconds > <teamdir>/started.txt
mkdir -p <teamdir>/reports
node scripts/experiment/prompt.js a1 <teamdir>                       # prompt for each agent
# ... run the five agents in parallel with those prompts ...
node scripts/experiment/analyze.js <teamdir>                         # usage and failure metrics
kill -INT $(cat <teamdir>/hub-seed.pid)                              # stop the holder
```

- **Prompts** point agents at `docs/AGENTS.md` (the playbook) instead of inlining a cheat sheet.
- **Roles** are in `roles.json`.
- **Traces:** every `hs` call is traced to `<teamdir>/trace.jsonl` by the per-agent wrappers
  (`HS_TRACE`).
- **Reports:** each agent writes a candid report with a JSON scorecard to `<teamdir>/reports/`.

To check the product independently, `hs clone` the invite into a fresh directory and run
`npm test` and `node src/cli.js plan fixtures/day1.json`.
