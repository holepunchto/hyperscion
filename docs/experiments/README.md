# Experiment data

The summaries are here and tracked:

- `quick/RUNLOG.md`: one entry per run of the quick loop (scenario, arm, outcome, what it found);
- `quick/TO-FIVE.md` and `quick/to-five.jsonl`: what agents said would make hs a 5, by run;
- `exp4/README.md` and `exp4/RUNLOG.md`: experiment 4, hs against a git control team.

The per-run archives those name (`quick/q2-hs-7/`, `exp4/s2-hs-1/`, `swarm/m7-2/` and so on:
traces, prompts, agents' reports, feeds, metrics) are not in git. They are about 1300 files, so
they stay on the machine that ran them; `.gitignore` keeps them out. The scripts under
`scripts/experiment/` still write and read them there: `setup.sh` and `inject.js` run a team,
and `analyze.js` and `outcomes.js` score a run directory.
