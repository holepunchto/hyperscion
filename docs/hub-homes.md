# Hub homes: many repos, one hub process

## Set one up

Do this on the machine the hubs run on, one that stays up:

```sh
hs hubs init                           # makes ~/hubs, a hub home, and this machine's default
hs hubs service install                # runs it as a service: at login, and again if it stops
hs hubs new my-project --as me         # a new repo in the home, served at once
hs hubs list                           # every repo's invite, main and how far it's settled
```

The hub home starts empty; each repo is one `hs hubs new` (or `hs hubs adopt`). `hs hubs new`
also makes your worktree for the repo, in `~/hubs/owners/my-project`. Work there, or move that
directory wherever you keep code (with no `hs` command running in it). `hs hubs new <repo>
--dir <folder>` makes a folder you already have the repo's worktree instead, files in place.

The service is a systemd user service on Linux or a launchd agent on macOS. It keeps hs up to
date by itself and restarts the hub for an update at a quiet moment
([Updates and restarts](#updates-and-restarts)). `hs hubs service status` and
`hs hubs service logs -f` show what it's doing. On Linux, run `loginctl enable-linger` once
so the hubs keep running after you log out.

Each repo has an admit directory in the home, `~/hubs/admit/<repo>`: a teammate or agent on
the hub's machine lets themselves in with `hs clone <invite> <dir> --as <handle> --admit
~/hubs/admit/<repo>`. From another machine, they send you the writer key `hs clone` prints,
and you run `hs hubs add-writer <repo> <key> --as <handle>`.

## What a hub home is

One machine can hub many repos from one process: a **hub home**, with one directory, one
store and one network node. It's how you [run hubs for real](start.md#2-run-your-hub-for-real).
Measured (`bench/hubs.js`), 30 repos hubbed from one home use 133 MB, against 3.3 GB as 30
separate `hs seed` processes, with the same land latency. Each repo still has its own hub key,
so finality, replacing a hub and `hs doctor` work per repo exactly as in [The hub](hub.md).

| command                                             | what                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `hs hubs init [dir]`                                | make a hub home (default `~/hubs`) and this machine's default       |
| `hs hubs new <repo>`                                | a new repo with its hub in the home, and your worktree in `owners/` |
| `hs hubs service install\|uninstall`                | run the home as a service, or stop doing so                         |
| `hs hubs service status`, `hs hubs service logs -f` | is it running, and what it says                                     |
| `hs hubs list`                                      | every repo's invite and how far it's settled; the hub's version     |
| `hs hubs gip <repo> [--off]`                        | publish the repo's main to git+pear from the home (or stop)         |
| `hs hubs restart [--now]`                           | restart the hub at the next quiet moment                            |
| `hs hubs adopt <repo> <hub dir>`                    | move an existing repo's hub into the home                           |
| `hs hubs add-writer <repo> <key> --as <h>`          | let a teammate write (`--indexer`: the repo's next hub)             |
| `hs hubs remove <repo>`                             | stop hubbing a repo here                                            |
| `hs hubs serve`                                     | run the home in the foreground, without a service                   |

They use the home `hs hubs init` made this machine's default. For another one, pass
`--home <dir>` or set `HS_HUB_HOME` (or run the command inside it). While the home is served,
they ask the server to do the work, since it holds the store.

What changes from one hub per repo:

- **One process hubs everything.** If it stops, every repo's lands stay provisional until it's
  back, which is why the home runs as a service.
- **One store.** All the repos' hub data lives in `~/hubs/store`, one namespace each, so a
  single repo's hub can't be moved by copying a directory. Moving one in or out uses the
  replacement procedure ([Replacing a hub](hub.md#replacing-a-hub)).
- **Repos are made on the hub's machine,** because the hub has to be created with the repo.
- **Not yet:** reclaiming a removed repo's space in the store, blind peers for a home's repos,
  and a service on Windows (run `hs hubs serve --updates` under your own supervisor there).

## Updates and restarts

The service runs `hs hubs serve --updates --restart-on-update`. hs updates itself over the
peer-to-peer network: when a new release is out, the hub fetches it within the hour (each
machine waits a random delay, so they don't all fetch at once) and replaces the `hs` binary.
The running hub keeps the old code until it restarts, so it then restarts at the next **quiet
moment**: every repo settled and no land for a minute, or after 30 minutes whatever happens.
It stops cleanly, and the service starts it again on the new binary.

A restart is safe at any time. For the few seconds the hub is down, lands stay provisional and
settle when it's back, and teammates' feeds reconnect by themselves. Waiting for a quiet moment
only keeps the restart out of the way.

- **To see it:** `hs hubs list` shows the version the hub runs, and whether an update is
  applied and a restart is pending. The service log says when it fetched, applied and
  restarted. Teammates' and agents' commands don't show the hub's version.
- **To restart it yourself:** `hs hubs restart` (at the next quiet moment) or
  `hs hubs restart --now`. With a service it comes back by itself; without one, run
  `hs hubs serve` again.
- **Without a service** (`hs hubs serve` in a terminal): add `--updates` to fetch them;
  `hs hubs list` then says when one is applied, and `hs hubs restart` runs it.
- **Teammates update their own `hs`,** so an agent can run a different version than the hub.
  hs doesn't compare versions between them yet.

**Moving a hub into a home.** `hs hubs adopt <name> <old hub dir>` runs the replacement
procedure in one step. Stop `hs seed` in the old hub first. The old hub grants the home's hub
weight 2 (as `hub2`, or the next free `hubN`), the home copies everything the old hub held,
and then the old hub is removed. Teammates change nothing; the invite stays the same. Never
run `hs seed` in the old directory again.

**Moving a repo out of a home.** This is the replacement procedure the other way round. Start
the next hub first, so it receives the change:

```sh
hs clone <invite> new-hub --as hub3 && cd new-hub && hs seed   # on the new machine; keep it running
hs hubs add-writer web-app <its key> --as hub3 --indexer        # on the hub's machine
hs hubs remove web-app                                          # the home's hub steps down
```

`hs hubs remove` refuses if the home is the repo's only hub. With `--force` it removes it
anyway, and the repo then settles on every writer's acks for good.
