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
  - `paths=<pattern>[,<pattern>]` runs the check only when a change touches one of these
    paths. Patterns work as in `/.hsattributes`: with no `/` a pattern matches the basename
    anywhere, `*` stays within one segment, and a trailing `/` matches everything under that
    directory.
- **`default`** names what `hs check` and `hs land` run.
- **`act <workflow>#<job>`** is a reserved kind, for running a CI workflow's job locally (see
  below). It parses, but doesn't run yet.

Mistakes (an unknown option, a `default` naming a check that doesn't exist) are reported by
line on every command that reads the file. The rest of the file still works.

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

**Both commands check the same tree.** They bring main into your files first, then run the
checks in the worktree root, so a pass from `hs check` means `hs land` should pass too,
unless main moves in between.

**What land does that `hs check` doesn't:**

- If main moves while a check runs, and the change is somewhere the check reads, land checks
  again. Changes outside your sparse checkout, or under paths `/.hsattributes` marks `-check`,
  don't trigger a re-run.
- Land stops at the first failing check, while `hs check` runs them all.

**`paths=` applies only to the default set.** A check you name always runs. With nothing
changed yet, `hs check` runs the whole default line.

**A repo with no `/.hschecks`** behaves as before: `hs land` checks only when given
`--check`, and `hs check "<cmd>"` runs a command.

**Sparse worktrees:** a check sees only the paths you've checked out, and `hs check` says so.

**The worktree's `.hs/` directory:** checks run in the worktree root, so a tool that walks
the whole tree (`prettier .`, a linter, `find`) sees `.hs/`, hs's own state, the way it would
see `.git/`. Most tools skip `.git/` by default but not `.hs/`, so add `.hs/` to their
ignore files (this repo's `.prettierignore` does).

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

- **A local result cache:** a check that passed on this exact tree doesn't run again at land.
- **Shared check records:** `hs log` shows which checks passed on which changeset, and by
  whom. `/.hsreview` can require them.
