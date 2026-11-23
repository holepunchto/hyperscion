# Commands

To explore them, run `hs --menu`: pick a command from a filterable list, fill a form built from
its flags (F1 explains the focused field; space on an empty path field opens a file or folder
picker), and it runs as the typed command would, printed so you learn it. `hs land --menu` opens one command's form directly; `hs <command> --help` has the
same descriptions and examples.

For the everyday loop there is `hs ui`, a lazygit-style terminal UI: Status, the files `land`
would send, the log, Review (your inbox and open asks) and Tasks (the board) on the left, the
selected diff on the right; `c` lands, `A` asks for review instead (pick reviewers from your
teammates), `p` syncs, `d` discards a file, `b` blames one (who last changed each line; `enter`
on a line shows its changeset); in Review `a` approves, `x` asks for changes, `m`
comments; in Tasks `n` files a task, `s` starts it, `S` stops, `D` marks it done, `X` drops it;
`?` lists the keys. It runs its commands on worker
threads, exactly as typed. In Neovim, the lazyscion plugin opens it in a float, as lazygit.nvim does for lazygit.

Every command that talks to peers does so by default; `--offline` opts out. A land is
**provisional** until the hub acks it, then **settled** (it can't be reordered), then **final**
(settled and accepted by review). `land` waits up to 10 s for the hub, so it usually ends with
`#27 final`.

| command                                                                        | what                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `init [dir] [--as handle] [--encrypt]`                                         | create a repo                                                                                                |
| `clone <invite> [dir] [--as handle] [--admit dir] [--sparse p]…`               | join a repo, request write access, sparse checkout                                                           |
| `status`                                                                       | your edits, unlanded work, stale files, lands not yet final, reviews for you                                 |
| `diff [--stat]`                                                                | what `land` would send, as a unified diff                                                                    |
| `ui`                                                                           | a lazygit-style terminal UI: files, diffs, log, review inbox and tasks; land, ask, review, sync by key       |
| `land [-m msg] [--check cmd] [-r handles] [--ship] [--wait-final] [--offline]` | commit, pull, rebase if main moved, check the merge (`/.hschecks` default, or `--check`), land, push, settle |
| `check [name…] [--list] [--no-sync]`                                           | run the repo's checks (`/.hschecks`) on main + your changes without landing                                  |
| `sync [--offline]`                                                             | bring main into your files and rebase your work onto it                                                      |
| `watch [--path p] [--count n] [--timeout s] [--for-me] [--json] [--stop]`      | stream lands, reviews and settlement as they happen                                                          |
| `log [path] [-n n] [--oneline]`, `show <n\|An> [--stat] [--path p]`            | history with files and states; a changeset or an ask with its diff                                           |
| `review` (alone: what waits on you), `review ask [-m] [-r handles] [-q n]`     | ask before landing (Ship / Show / Ask, see [AGENTS.md](AGENTS.md))                                           |
| `review approve\|changes\|comment <An\|n\|Tid> [-m]`, `review list [--all]`    | approve, submit feedback suggesting changes, or comment; every open ask                                      |
| `task` (the board), `task show\|new\|split\|start\|stop\|done\|drop`           | who builds what: start a task before building it ([TASKS.md](TASKS.md))                                      |
| `ls [prefix]`, `cat <path>`                                                    | read main (or `--ws`, your workspace) without a checkout                                                     |
| `commit`, `restore <path…>`, `checkout [prefix…]`                              | checkpoint edits, discard edits, materialize files (optionally sparse)                                       |
| `export <dir> [--at n]`                                                        | write main as it was at changeset #n into a directory (like `git archive`)                                   |
| `ws new\|switch\|list`                                                         | workspaces                                                                                                   |
| `fetch`, `push`                                                                | download main without touching files; make sure a holder has your lands                                      |
| `seed [--admit dir] [--no-mirror] [--updates] [--gip]`                         | be the team's holder: stay online, hold everything, settle lands, admit writers (and publish to git+pear)    |
| `hubs new\|serve\|list\|adopt\|add-writer\|remove` (`--home dir`)              | host many repos' hubs from one process (a hub home), and move hubs in and out                                |
| `info`, `doctor`, `add-writer <key> --as handle [--indexer]`                   | identity, connectivity and settlement, access                                                                |
| `access [--json]`, `revoke <handle> [--force]`                                 | who can write (and who was removed), what reading takes; take a writer's write access away                   |
| `remove-writer <handle or key>`                                                | take out a writer gone for good (a dead hub): settlement stops waiting for it; add its replacement first     |
| `blind-peer <key> [--remove]`                                                  | configure blind peers                                                                                        |
| `import-git [gitdir] [--branch] [--limit] [--tip]`                             | replay a git branch's first-parent history onto main (`--tip`: only its files, one changeset)                |
| `export-git <branch> [--since n] [--onto ref] [--force]`                       | write what landed since the git import as a git branch, one commit per changeset                             |
| `gip publish [--name n]`, `gip import <git+pear link> [--branch]`              | publish main as a git+pear repo; land commits git users pushed to theirs                                     |

## hs for git users

| git                                             | hs                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `git clone <url>`                               | `hs clone <invite>`                                                |
| the shared remote (`origin`)                    | the hub, though it only orders and holds lands ([The hub](hub.md)) |
| `git status`, `git diff`, `git log`             | `hs status`, `hs diff`, `hs log`                                   |
| `git commit` + `git pull --rebase` + `git push` | `hs land`: commits, rebases onto main, retries, pushes             |
| `git pull --rebase`                             | `hs sync`                                                          |
| `git switch -c feature`                         | `hs ws new feature` (a workspace, forked in constant time)         |
| `git restore <path>`                            | `hs restore <path>`                                                |
| `git show <commit>`                             | `hs show <n>` (changesets are numbered: `#27`)                     |

Two things are new. A land is **provisional** for a moment, until the hub has seen it; then
it's **final**, once any review it asked for is done. `hs land` waits for that and says which.
And `hs watch` streams teammates' lands as they happen, so nobody needs to poll.

## Ignoring files

hs honors your `.gitignore` files, so `node_modules/` and build output never
land. An optional `.hsignore` (same syntax, in the same places) applies after them: add patterns
git tracks but hs shouldn't, or share what git ignores with `!dist/`. Unlike `.npmignore`, it
never replaces `.gitignore`. Only untracked files are ignored, as in git, and
`hs status --ignored` lists what's skipped and any tracked files a rule matches.
