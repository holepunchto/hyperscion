# Checks: what "verified" means is the repo's call

Agents land many small changes, so each land should check its result. The project says what
that check is, not hs. Before `/.hschecks`, hs's own playbooks told every agent to run
`npm test`, which is wrong for any repo whose quality bar is something else (lint, a build,
a typecheck, a quick test tier).

A repo declares its checks in `/.hschecks` on main. Every teammate sees the same file, and
changing it is a land like any other.

```
# name   [options]          kind  command
lint                         run   npm run lint
test     timeout=10m         run   npm test
integ    manual              run   npm run test:integration
docs     paths=/docs/,*.md   run   node scripts/check-docs.js
default  lint test docs
```

- **One check per line:** a name, options, the kind, then the command. The command is the
  rest of the line as written, so it may contain `#`, `=` or quotes. Only lines starting with
  `#` are comments.
- **Options** go before the kind:
  - `timeout=<n>[s|m|h]` kills the check, and everything it started, after that long.
  - `manual` runs the check only when it's named, never as part of `default`.
  - `parallel` runs the check at the same time as the `parallel` checks next to it in the
    list. Output still prints in list order, one check at a time. Only use it for checks that
    don't write the same files.
  - `paths=<pattern>[,<pattern>]` runs the check only when a change touches one of these
    paths. Patterns work as in `/.hsattributes`: with no `/` a pattern matches the basename
    anywhere, `*` stays within one segment, and a trailing `/` matches everything under that
    directory.
- **`default`** names what `hs check` and `hs land` run.
- **`act <workflow>#<job>`** is a reserved kind, for running a CI workflow's job locally (see
  below). It parses, but doesn't run yet.

Mistakes (an unknown option, a `default` naming a check that doesn't exist) are reported by
line on every command that reads the file. The rest of the file still works.

**A repo without `/.hschecks`** lands as before, with no checks run. A land that changes more
than `NOTES.md` says so (`no checks ran: this repo declares none`), so whoever reads the
output knows that nothing verified it.

## Using it

| Command                      | What it runs                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `hs land`                    | the default checks, on main + your changes; lands only if they pass                 |
| `hs land --check lint,test`  | those checks, `manual` ones included                                                |
| `hs land --check "npm test"` | that command: anything that isn't a check name is a shell command, as it always was |
| `hs land --skip-checks`      | no checks                                                                           |
| `hs check`                   | the default checks without landing; runs every one, exits 1 if any failed           |
| `hs check test integ`        | those checks                                                                        |
| `hs check --list`            | what `/.hschecks` defines                                                           |
| `hs check --no-sync`         | the checks on your files as they are, without bringing main in first                |
| `hs check --recheck`         | every check, even one that already passed on this exact tree                        |

**Both commands check the same tree.** They bring main into your files first, then run the
checks in the worktree root, so a pass from `hs check` means `hs land` should pass too,
unless main moves in between.

**What land does that `hs check` doesn't:**

- If main moves while a check runs, and the change is somewhere the check reads, land checks
  again. Changes outside your sparse checkout, under paths `/.hsattributes` marks `-check`, or to
  `merge=union` files such as NOTES.md (unless marked `check`), don't trigger a re-run.
- Land stops at the first failing check, while `hs check` runs them all.

**A pass is remembered for this exact tree.** A check that already passed on the tree you're
about to check isn't run again, by `hs check` or by land:
`check test passed on this tree 40s ago (not run again)`. So `hs check` while you work,
then `hs land`, costs one run, not two. On this repo that's 47 s, then 1 s.

- **What "this tree" means:** main as your work is based on it (its hash, so a reordered main
  counts as different), plus every changed path and its content.
- **What re-runs a check:** a change to any file, main moving, or editing the check's command
  in `/.hschecks`.
- **Only passes are kept.** A failing check always runs again.
- **Where it's stored:** `.hs/checks.json`, which is local to the worktree.

**A hit can be stale.** The cache doesn't see what the tree doesn't hold (`node_modules`,
tools, the environment), the same blind spot as any local test run. `hs check --recheck`
runs everything regardless.

**`paths=` applies only to the default set.** A check you name always runs. With nothing
changed yet, `hs check` runs the whole default line.

**A repo with no `/.hschecks`** behaves as before: `hs land` checks only when given
`--check`, and `hs check "<cmd>"` runs a command.

**Sparse worktrees:** a check sees only the paths you've checked out, and `hs check` says so.

**The worktree's `.hs/` directory:** checks run in the worktree root, so a tool that walks
the whole tree (`prettier .`, a linter, `find`) sees `.hs/`, hs's own state, the way it would
see `.git/`. Most tools skip `.git/` by default but not `.hs/`, so add `.hs/` to their
ignore files (this repo's `.prettierignore` does).

## What a land records, and requiring checks

**Every land records the checks it passed.** `hs log` shows them under the message, and
`hs log --oneline` at the end of the line. `hs show` gives names and times, and says which
passes came from the cache. `hs watch --json` puts them in each changeset's `checks`. They
are the checks run on the land's base plus its changes. A land that main moved under
(outside what the check reads) is recorded with the checks of the state it checked.

**`/.hsreview` can require checks** for paths, enforced when the land is applied, so every
peer agrees:

```
/src/          checks=lint,test
contract.md    approvals=1 checks=lint
```

- **A land touching a covered path must carry each named check.** Without them it's
  refused as `needs-check`, naming the path, the missing checks and the rule.
- **Patterns** work as in `/.hsattributes`: a trailing `/` covers everything under the
  directory. A line can also say `approvals=`.
- **`hs land` runs what the rules require** for the paths it touches, even when the default
  line leaves those checks out, and even with `--skip-checks`. `hs check` does the same, so
  its passes are the ones land reuses.
- **A required check that `/.hschecks` doesn't define** is refused before anything runs.
- **A `--check "<command>"` has no name,** so it can't stand in for a required check.

**This is the lander's word.** A record says the lander's hs ran these checks and they
passed. That keeps honest agents from forgetting, and lets teammates see what was verified.
It can't stop a writer who lies, any more than a commit message can. Real attestation,
peers that re-run checks and sign the result, is where the reserved `act` kind and a
separate check op would come in.

**`checks=` is part of the repo rules every peer applies** (repo ABI 1; see
[DESIGN.md §16](DESIGN.md#16-rules-versioning-the-repo-abi)). A future `/.hsreview`
attribute will count only once an owner moves the repo to the ABI that introduces it
(`hs upgrade-repo`), so peers on an older hs never disagree about a land: they stop instead.

## Why hs doesn't run the CI workflows (yet)

The obvious alternative was to run the project's `.github/workflows` jobs locally with
[nektos/act](https://github.com/nektos/act). A spike in November 2026 timed `ci.yaml#lint`
on this repo:

| How it ran                                      | Wall time |
| ----------------------------------------------- | --------- |
| `npm run lint`                                  | 6.3 s     |
| act in rootless podman, warm (reused container) | 142 s     |
| act on the host                                 | 20 s      |
| act on the host, with two patches to act        | 10.6 s    |

**What act added on the host** was the workflow's setup steps (install Node, install
dependencies). A dev machine has already done those. Some are harmful there:
`holepunchto/actions`' `setup-repo` runs `npm config set` and `git config`, and the build job
runs `npm i -g`. Host mode gives no isolation and no other operating systems. Containers do,
but cost minutes per run. Upstream act also lacks the `case()` expression function our
actions use, and ignores `--bind` in host mode, so we'd have had to ship a fork.

**What matters for agents** is that the repo, not hs, decides the checks, and (next) that
results are shared. The reserved `act` kind is where workflow runs come back: hermetic runs
on a peer that checks for others, where a clean environment is the point.

## Next

- **Check peers:** a peer that re-runs a changeset's checks (hermetically, perhaps with the
  `act` kind) and records the result as its own op, an attestation rather than the lander's
  word.
