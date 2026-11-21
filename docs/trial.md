# Try hs next to git: a swarm of agents for one piece of work

**For you if** your code lives in git (GitHub, GitLab, any remote, or a
[git+pear](git-pear.md) (gip) repo), you're keeping it there, and you want a swarm of agents to
work on one feature or a large chunk of work in parallel for a while. hs is built for many
writers landing at once: no merge queue, no rejected pushes, a live feed of what everyone
landed, and tasks so two agents don't build the same thing.

The trial is a side folder with its own hub. Your git checkout and your remote stay as they
are, and nobody else on the team needs hs. At the end you get the agents' work back as an
ordinary git branch, one commit per change, and you delete the side folder. If you'd rather
the team moved to hs for good, see [Move a repo from git](from-git.md).

```
your git checkout ──(1) git worktree──▶ app-trial/swarm ──(2) hs import-git --tip──▶ hs main
                                                                                  │
                                         agents clone, land, land, land ◀────(3)──┘
                                                                                  │
your git checkout ◀──(4) hs export-git: a branch, one commit per changeset ───────┘
```

You need `hs` installed ([Install](install.md)) and `git`.

## 1. Get in

From your git checkout (here `~/code/app`), on the commit the work should start from:

```sh
cd ~/code/app
git worktree add --detach ../app-trial/swarm   # a second checkout of this commit
cd ../app-trial/swarm
hs init --as me --hub ../hub                   # an hs repo in this folder, and its hub
```

Everything for the trial lives in one folder beside your checkout, `app-trial/`, so cleaning
up is one `rm -rf`. `app-trial/swarm` is a [git worktree](https://git-scm.com/docs/git-worktree):
it shares your repo's history but has its own files, so you can keep working in `~/code/app`
meanwhile, and switching branches there never touches what the agents see. hs keeps its data
in `swarm/.hs/` and keeps that out of `git status`.

Start the hub and leave it running for the length of the trial (a terminal of its own, or
`tmux`). `--admit` lets agents on this machine add themselves as writers:

```sh
cd ../hub && hs seed --admit ../admit
```

Then bring in the files, and print the invite agents clone with:

```sh
cd ../swarm
hs import-git --tip    # this commit's files as changeset #1; it remembers the commit
hs sync                # this folder is now an hs worktree of main #1
hs info                # `invite` is what agents clone
```

`--tip` takes only the files, which is quick on any size of repo. Without it, `import-git`
replays the branch's whole first-parent history, one changeset per commit, so `hs log` and
`hs blame` reach back past the trial.

## 2. Bring in the agents

Each agent gets its own worktree, cloned from the invite:

```sh
hs clone <invite> ../agent-1 --as a1 --admit ../admit   # app-trial/agent-1
hs clone <invite> ../agent-2 --as a2 --admit ../admit
```

An agent on another machine clones without `--admit`, sends you the writer key `hs clone`
prints, and you add it: stop `hs seed`, run `hs add-writer <key> --as a3` in `app-trial/hub`, and
start `hs seed` again.

Give each agent its folder, the task, and the hs playbook: `hs agents` prints a short version
to paste into its instructions (`hs agents --full` for the whole of [AGENTS.md](AGENTS.md)), or
tell it to run `hs agents` first. Skip `hs agents --write` in a trial: the `AGENTS.md` it saves
in the worktree would land, and end up in your branch. Agents land small changes as they go,
follow each other with `hs watch`, and claim pieces of work with `hs task`
([TASKS.md](TASKS.md)).

## 3. While it runs

- `hs log` (in any worktree) is the history so far; `hs show 12` is one change with its diff;
  `hs ui` is a terminal UI over all of it.
- You can land in `app-trial/swarm` too: it's your worktree in the trial.
- Your git checkout is untouched. Teammates keep committing and pushing as usual.

## 4. Get out: the work as a git branch

With the hub still running, from the trial folder:

```sh
cd ~/code/app-trial/swarm
hs export-git swarm-results
```

```
wrote #2..#41 as 40 commit(s) on swarm-results, on top of 3f2a9c1
git log 3f2a9c1..swarm-results   # review; then push it or merge it as usual
```

`swarm-results` is a branch in your repo, so `~/code/app` sees it too. It starts from the
commit you imported, with one commit per change the agents landed, each with its author
(their handle), time and message. From here it's plain git:

```sh
cd ~/code/app
git log --stat main..swarm-results       # review it
git push origin swarm-results            # and open a pull request, or merge it yourself
```

If `main` moved on in git during the trial, the branch meets those changes in git, as any
feature branch does: rebase it or merge it, and resolve conflicts there.

A few things to know:

- **Only settled changes are exported,** the ones the hub has seen, because a provisional one
  can still move. That's why the hub has to run. If any are left out, it says how many.
- **Want more?** Agents can keep landing. Run `hs export-git` again with a new branch name, or
  with `--force` to rewrite `swarm-results`. The same changes always give the same commits.
- **One squashed commit instead?** After `hs sync` in `app-trial/swarm`, the folder holds the
  result: `git switch -c swarm-results && git add -A && git commit` there.
- **On git+pear?** Your checkout is a clone of a git+pear repo, so the branch goes back the
  way your other work does: `git push git+pear://<key>/<name> swarm-results` to a repo you can
  write (your own), and the owner merges it from there.

## 5. Clean up

Stop each agent's `hs watch` (`hs watch --stop` in its folder) and the hub (ctrl+c), then:

```sh
cd ~/code/app
git worktree remove --force ../app-trial/swarm   # git forgets the trial checkout
rm -rf ../app-trial                              # the hub, the agents, everything else
```

That's everything. What stays in your repo is the `swarm-results` branch and one line, `/.hs/`,
in `.git/info/exclude` (harmless; delete it if you like).

## Doing it again

Each trial is its own throwaway hs repo, so the next one starts again from step 1 at whatever
commit you're on then. To keep one running for good instead, and have the team land in it, see
[Move a repo from git](from-git.md).
