# Start a new repo

**For you if** you're new to hs and starting fresh: a new project, or a folder of files that
isn't in git. (Code in git? See [Move a repo from git](from-git.md) or
[Try hs next to git](trial.md).)

You'll go through three steps:

1. **Try it** on your machine, with a throwaway hub next to the repo. Five minutes.
2. **Run your hub for real**: one service on a machine that stays up hubs all your repos.
3. **Bring in teammates and agents.**

You need `hs` installed ([Install](install.md)).

## 1. Try it on your machine

```sh
mkdir demo && cd demo
hs init --as me --hub ../demo-hub    # a repo here, and its hub next to it in ../demo-hub
(cd ../demo-hub && hs seed > ../demo-hub.log) &   # run the hub while you try things
until grep -q seeding ../demo-hub.log 2>/dev/null; do sleep 0.2; done   # wait until it's up
echo hello > README.md
hs diff                      # what land would send
hs land -m "first"           # commit + land onto main: ends with `#1 final`
hs log

hs ws new feature            # O(1) fork of main
echo "hello world" > README.md
hs land -m "feature"
hs ws switch default && hs sync
kill %1                      # stop the hub when you're done
```

`--hub` made a second directory, `../demo-hub`. That's the repo's **hub**: the peer that
makes lands final and keeps a copy of everything landed ([The hub](hub.md)). For a try it
runs on your machine next to your repo.

The one thing you can't change later is whether a repo has a hub: it can only be made
together with the repo. Where the hub runs is up to you later, and nothing you do here is
lost when you move it (step 2).

**Which to use, `hs init --hub` or a hub home?** `hs init --hub` makes one repo with its own
hub directory, which you run with `hs seed`: right for a try. For anything you'll keep, make
repos in a hub home (step 2), where one service hubs them all.

## 2. Run your hub for real

A hub has to be online whenever anyone works, so once you go past a try, run it as a service
on a machine that stays up: your own, to start with. One process can hub every repo you make,
from one directory, a **hub home**. On the machine the hub runs on:

```sh
hs hubs init                           # makes ~/hubs, a hub home, and this machine's default
hs hubs service install                # runs it as a service: at login, and again if it stops
hs hubs adopt demo ../demo-hub         # optional: bring the demo's hub along (its hs seed stopped)
hs hubs new my-project --as me         # a new repo in the home, served at once
hs hubs list                           # every repo's invite, main and how far it's settled
```

`hs hubs new` also makes your worktree for the repo, in `~/hubs/owners/my-project`. Work
there, or move that directory wherever you keep code (with no `hs` command running in it).

**A folder you already have** becomes a repo in place:

```sh
hs hubs new notes --dir ~/notes        # ~/notes becomes the repo's worktree; its files stay put
cd ~/notes && hs land -m "first"       # lands them (.gitignore is honored, .git never lands)
```

On Linux, run `loginctl enable-linger` once so the hubs keep running after you log out.
[Hub homes](hub-homes.md) covers the service, updates, and moving hubs in and out.

## 3. Bring in teammates and agents

Each repo has an admit directory in the hub home. A teammate or agent on the hub's machine
lets themselves in:

```sh
hs clone <invite> ../bob --as bob --admit ~/hubs/admit/my-project
```

From another machine, a teammate clones, then sends you the writer key `hs clone` prints, and
you add it on the hub's machine: `hs hubs add-writer my-project <key> --as bob`.

For agents, read **[AGENTS.md](AGENTS.md)**, the playbook. `hs agents --write` saves a short
version as `AGENTS.md` in a worktree, where agent tools read it. [TASKS.md](TASKS.md) covers
how agents claim work so two of them don't build the same thing.

`hs hubs new --encrypt` (or `hs init --encrypt`) encrypts all repo data at rest. The invite
then carries the key.

## Everyday use

`hs status`, `hs land`, `hs sync` and `hs watch` are most of it; `hs ui` is a terminal UI for
the same loop. [Commands](commands.md) has the rest, and a git-to-hs cheat sheet.

## Getting out

Your files are always plain files in your worktree. `hs export <dir>` writes main as it was at
any changeset into a folder. For the history too, run the hub with `hs seed --gip` (or
`hs hubs gip <repo>` in a hub home): it publishes main as a git repo with one commit per
changeset ([git+pear](git-pear.md)). `git clone git+pear://<key>/<name>` (with
[gip](https://github.com/holepunchto/gip-transport) installed) gives you a git checkout of it,
which you can push to any git remote.
