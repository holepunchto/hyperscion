# Working in a team with git: the agent playbook

The control arm of our experiments (docs/EXPERIMENTS.md, round 4). It's the best reasonable
setup we could give a team on plain git, so the comparison with hs is fair. You get:

- a clone of a shared `origin` (always up, like a GitHub without the web UI);
- a `git` command that records every call;
- `pull.rebase`, `rebase.autoStash` and `zdiff3` conflict markers configured;
- `NOTES.md` union-merged via `.gitattributes`, so concurrent appends never conflict.

## The model in four lines

- **`origin/main`** is the shared history. Everyone pushes to it directly; there are no PRs.
- **Your clone** is private until you push. Commit small and often.
- **A push is rejected** when someone else pushed first. Then `git pull` (it rebases your
  commits on top), run the tests again, and push again.
- There's no feed. You learn what teammates did by fetching and reading the log.

## The loop

1. **See what teammates did:**

   ```sh
   git fetch -q && git log --oneline --stat HEAD..origin/main   # what landed since your last pull
   git show <sha>                                              # one commit with its diff
   git log -p origin/main -- src/geo.js                        # history of one file
   git show origin/main:src/geo.js                             # the latest version, no checkout
   ```

2. **Bring their work in** before building on it: `git pull` (it rebases your local commits
   onto `origin/main`, stashing uncommitted edits for you).
3. **Land small and often, tested.** Write messages for your teammates; they read them in
   the log.

   ```sh
   git add -A && git commit -m "scheduler: Plan shape pinned in CONTRACTS.md"
   git pull && npm test && git push
   ```

   If the push is rejected (`! [rejected] ... (fetch first)`), someone pushed in between:
   run the same line again. Don't push without the tests passing on top of the latest main.

4. **Wait for a teammate** without busy-looping too hard, e.g. until `src/model.js` lands:

   ```sh
   for i in $(seq 1 30); do git fetch -q; git log --oneline HEAD..origin/main -- src/model.js | grep -q . && break; sleep 20; done
   ```

## Shared files and conflicts

- `NOTES.md` is union-merged: add lines, don't rewrite others' lines.
- For code files, a rebase can stop with `CONFLICT (content): Merge conflict in <file>`. Fix
  the `<<<<<<<` markers, then `git add <file> && git rebase --continue`, test, push.
  `git rebase --abort` gets you back to before the pull.

## Asking for review

Every change is one of three kinds:

- **Ship:** your own files, routine changes. Just push.
- **Show:** you changed someone else's files. Push, and add a `NOTES.md` line naming the
  owner (`- [a2] touched src/report.js (a4): ...`).
- **Ask:** interfaces and contracts others build on, anything risky.
  1. Push a branch: `git push origin HEAD:ask/<topic>`.
  2. Note it in `NOTES.md`, naming the reviewer.
  3. The reviewer looks at it with `git fetch && git diff origin/main...origin/ask/<topic>`
     and answers in `NOTES.md`.
  4. Once it's approved, merge it into main and push.

## What the messages mean

| you see                                                          | meaning                                  | do                                                |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `! [rejected] main -> main (fetch first)`                        | someone pushed first                     | `git pull && npm test && git push`                |
| `CONFLICT (content): Merge conflict in X`                        | overlapping edits                        | fix markers, `git add X`, `git rebase --continue` |
| `Successfully rebased and updated refs/heads/main`               | your commits now sit on the latest main  | test, push                                        |
| `fatal: ... does not appear to be a git repository` / can't read | origin (or your network) is down         | keep committing locally; push when it's back      |
| `Your branch is ahead of 'origin/main' by N commits`             | you have unpushed commits                | push                                              |
| `error: cannot pull with rebase: You have unstaged changes`      | autostash didn't apply (e.g. a conflict) | `git stash`, `git pull`, `git stash pop`          |

## Good to know

- `git status -sb` shows your edits and how far ahead or behind you are.
- `git log --oneline -n 10 origin/main` lists recent commits; `git log --stat` adds files.
- Never force-push to main.
