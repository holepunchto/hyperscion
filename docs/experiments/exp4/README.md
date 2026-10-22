# Experiment 4 raw data

Copied from the session scratchpad after the series. These files are kept as they were
written, and the analysis is in docs/EXPERIMENTS.md ("Experiment 4"). Paths inside them point
at the original scratchpad.

There is one folder per run, named `<scenario>-<arm>-<n>`. Each folder holds:

- `reports/`: each agent's report, ending in its JSON scorecard;
- `prompts/`: the exact prompt each agent got;
- `trace.jsonl`: every `hs` or `git` call, with its output;
- `analysis.txt` and `metrics.json`: the output of `scripts/experiment/analyze.js`, plus the
  outcomes that `outcomes.js` merges in;
- `outcomes.json`: one row per state of main, with test and acceptance results;
- `fault-events.jsonl`: the schedule `inject.js` ran (empty for S1);
- `run.json` and `started.txt`: the arm, the scenario and the start time.

`RUNLOG.md` is the running log kept during the series. It records incidents and fixes made
mid-series, such as the playbook leak, the failed setups and the harness fixes.
