# Move a repo from git

**For you if** your code lives in git and you want the team (people and agents) to work in hs
from now on, with hs's main as the source of truth. Just want to try a swarm of agents on one
piece of work and stay on git? See [Try hs next to git](trial.md) instead.

It works the same whatever the remote is: GitHub, GitLab, a self-hosted server, or a
[git+pear](git-pear.md) repo. hs reads your local checkout, never the remote.

You need `hs` installed ([Install](install.md)) and `git`.

## 1. Make the repo

The repo needs a hub that stays up while anyone works. For a repo you're keeping, that's a hub
home running as a service ([Hub homes](hub-homes.md)); set one up once per machine with
`hs hubs init && hs hubs service install`. Then, on the hub's machine:

```sh
hs hubs new app --as me                # the repo, its hub, and your worktree: ~/hubs/owners/app
```

(To kick the tyres first, `hs init --as me --hub ../app-hub` in an empty folder makes the repo
with a hub in a folder of its own, which you run with `hs seed` there. [The hub](hub.md)
explains both.)

## 2. Bring in the history

In your new worktree, before landing anything, import from your git checkout (here
`~/code/app`):

```sh
cd ~/hubs/owners/app
hs import-git ~/code/app   # its current branch, one changeset per commit, authors and times kept
hs sync                    # the files, in this worktree
```

`import-git` replays the branch's first-parent history: each commit becomes one changeset with
its author, time and message, so `hs log` and `hs blame` go back to the start. Merge commits
come in as the change they made to the first parent. Symlinks and submodules are skipped (it
says how many). `--branch <ref>` imports another branch; `--tip` imports only the files as they
are now, as one changeset, if you don't need the history.

The import goes to the hub when it's done, so teammates who clone get all of it. Your git
checkout is left exactly as it was. hs honors `.gitignore` and never lands `.git`.

**Or in place.** `hs hubs new app --as me --dir ~/code/app`, then `hs import-git` and `hs sync`
in `~/code/app`, makes the git checkout itself the hs worktree (hs keeps `.hs/` out of
`git status`). If you do, stop using git to change files there: a `git switch`, `pull`,
`reset` or `stash` rewrites files under hs, which sees them as your edits, and the next
`hs land` would send them, undoing teammates' work. Check `hs status` before landing.

## 3. Move the team over

Send teammates the invite (`hs info` prints it). Each clones into a new folder; they don't need
git:

```sh
hs clone <invite> ~/code/app-hs --as bob --admit ~/hubs/admit/app   # on the hub's machine
```

From another machine, they clone without `--admit` and send you the writer key `hs clone`
prints; you run `hs hubs add-writer app <key> --as bob`. Agents join the same way; give them the
playbook ([AGENTS.md](AGENTS.md), or `hs agents --write` in their worktree).

[Commands](commands.md) has a git-to-hs cheat sheet. The short version: `hs land` does
commit, pull, rebase and push in one step, and `hs sync` is `git pull --rebase`.

## 4. Decide what happens to the old remote

Once the team lands in hs, stop pushing to the old remote, or the two drift apart. Then pick
one:

**Keep it as a read-only mirror.** CI, deploys and people who only read can stay on it.
Whenever you want it updated, from your hs worktree:

```sh
hs export-git hs-main --force --git-dir ~/code/app && git -C ~/code/app push origin hs-main:main
```

`export-git` writes every settled changeset since the import as a commit on top of the commit
you imported, into the git checkout you name, so the push is a fast-forward of the old `main`.
The same changesets give the same commits (as long as nobody's handle changes), so running it
again only adds the new ones. Pull `main` in that checkout afterwards if you look at it there.

**Give git users a git+pear repo.** `hs seed --gip` on the hub (or `hs hubs gip app` in a hub
home) publishes main as a git+pear repo that anyone with [gip](https://github.com/holepunchto/gip-transport)
can clone, and lands their commits back with `hs gip import`. Its history is hs's own (one
commit per changeset, starting at #1), not your old git history. See [git+pear](git-pear.md).

**Archive it.** Mark it read-only on the host so nobody pushes to it by mistake.

## Going back to git

The same `export-git` is the way back: it gives you a branch of everything landed on top of your
old history. Push it as `main`, then remove hs: stop hubbing the repo (`hs hubs remove app
--force`, since you're retiring its only hub on purpose, or stop `hs seed`), and delete `.hs/`
in each worktree.
