# History: how hs got here

The user docs describe hs as it is. This folder keeps the records behind it: design proposals,
bug write-ups and decisions, with the experiment runs that drove them
([EXPERIMENTS.md](../EXPERIMENTS.md), [experiments/](../experiments/)). Command names and
behaviour here are as they were at the time.

| record                                               | what                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [tasks-design.md](tasks-design.md)                   | the tasks (claims) proposal: items, signals and records, leads, approvals, phases and gates  |
| [coordination-decision.md](coordination-decision.md) | October 2026: keep claims and shrink their surface, from the q0/q0b/q0bo/q2s runs            |
| [finality-site-split.md](finality-site-split.md)     | the q0bs site-split bug where "final" could move in `init --hub` repos, the options, the fix |

Earlier command names, for reading old run logs: `hs task` was `hs claims`; `task new` was
`item new` (`--idea` was `suggest`); `task split` was `item part`; `task start` was `claim`;
`task stop` was `claim --release`; `task done` was `claim --done`; `hs review` was `hs inbox`;
`hs review ask` was `hs propose`; `land --online`/`-o` became the default.
