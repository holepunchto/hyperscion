# hyperscion

Peer-to-peer source control for agent-scale change volume, built on the Holepunch stack:
[hyperbee2](https://github.com/holepunchto/hyperbee2),
[autobee](https://github.com/holepunchto/autobee),
[hyperdrive on hyperbee2](https://github.com/holepunchto/hyperdrive/pull/422) and
[blind peers](https://github.com/holepunchto/blind-peering). It ships as a standalone
[Bare](https://github.com/holepunchto/bare) binary, `hs`.

hyperscion takes the ideas behind Anthropic's
[Scion](https://www.anthropic.com/engineering/redesigning-source-control) and asks how far a
system can get without a server:

- **Workspaces fork main in O(1).** A workspace's tree is rooted directly in main's B-tree, in
  another peer's core.
- **Commits cost O(change).** Only the dirty root-to-leaf paths are written.
- **Lands are lock-free.** Main is a multiwriter autobee. Every peer deterministically accepts
  or rejects a land by path-level optimistic concurrency, with a self-verifying hash-chain base.
  There is no merge queue.
- **Reads are lazy and verifiable.** Peers fetch exactly the blocks they read, from anyone,
  and merkle proofs mean no cache can lie.
- **Data stays available without a server.** Mirror peers (`hs seed`) or blind peers
  that hold encrypted blocks they cannot read.

> [!NOTE]
> This an experimental library. A version 1.0.0 release will signal stability. Until that point be very careful about data/file loss.

This is a milestone-1 prototype. **[docs/DESIGN.md](docs/DESIGN.md)** has the architecture, the
Scion mapping, the measured results (including where git still wins) and the open problems.

## Install

Or with the [Pear CLI](https://install.pears.com):

```sh
pear install pear://scioncigzgdpiwsr6een9suoj8irromdwor6ze9urfx9ya5sajry
```

With npm:

```sh
npm init hyperscion
```

That's `npm init`, not `npm install`: npm runs the `create-hyperscion` package, which fetches
the `hs` binary peer-to-peer with [pear-install](https://www.npmjs.com/package/pear-install)
(what `pear install` uses) and puts it in `~/.local/bin/hs` on macOS and Linux, or
`%LOCALAPPDATA%\Programs\hs\hs.exe` on Windows. `npm init -y hyperscion` skips the question.
The npm package is only the installer (a few kB, no dependencies); the binary comes from peers.

## Quick start

```sh
npm install
alias hs="bare $PWD/bin.mjs"

mkdir demo && cd demo
hs init --as me --hub ../demo-hub    # prints the repo invite, and creates the team's hub
(cd ../demo-hub && hs seed > ../demo-hub.log) &   # the hub: it holds lands and makes them final
until grep -q seeding ../demo-hub.log 2>/dev/null; do sleep 0.2; done   # wait until it's online
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

Don't skip the hub. It is the always-on peer that keeps landed work available and makes lands
final, and it can only be created along with the repo. Without one, lands stay on your machine
until someone else is online. [The hub](#the-hub) explains what it does and how to run it.

For teams, and AI agents in particular, read **[docs/AGENTS.md](docs/AGENTS.md)**. It's the
playbook: watch instead of poll, sync, land small, learn from teammates' diffs. The binary
carries the agent instructions too: `hs agents` prints a short brief (docs/BRIEF.md),
`hs agents --full` the playbook, and `hs agents --write` saves the brief as `AGENTS.md` in the
worktree, where agent tools read it. To set up a
team with one command (an always-on holder plus N writable worktrees):

```sh
scripts/team.sh ./team 5      # hub runs `hs seed --admit`, agents in team/agents/a1..a5
```

Every team needs a **hub**: a worktree running `hs seed` (see [The hub](#the-hub)).

Collaborating across machines by hand:

```sh
# machine A: the hub created by `hs init --hub ../my-hub`
cd ../my-hub && hs seed       # stay online, hold all landed content, settle lands

# machine B
hs clone <invite> work --sparse src   # only materialize src/
cd work && hs info                     # copy the writer key

# machine A: admit without stopping the seed (`hs seed --admit ./admit`, and clone with
# `hs clone <invite> --as bob --admit ./admit`), or stop the seed and:
hs add-writer <writer-key> --as bob

# machine B
hs land -m "my change"                 # pulls, rebases if main moved, pushes, waits to settle
```

`hs init --encrypt` encrypts all repo data at rest. The invite then carries the key.

**Ignoring files.** hs honors your `.gitignore` files, so `node_modules/` and build output never
land. An optional `.hsignore` (same syntax, in the same places) applies after them: add patterns
git tracks but hs shouldn't, or share what git ignores with `!dist/`. Unlike `.npmignore`, it
never replaces `.gitignore`. Only untracked files are ignored, as in git, and
`hs status --ignored` lists what's skipped and any tracked files a rule matches.

## The hub

The hub is a worktree running `hs seed`, on a machine that stays online. It does two jobs:

- **It makes lands final.** The hub is the repo's indexer. Once it has seen a land, the land's
  place in main's history is fixed (_settled_), and nothing can reorder or undo it.
- **It holds everything landed,** so teammates can fetch your work after your machine goes
  away. With `--admit <dir>` it also lets new writers in.

### Isn't a hub a central point of failure?

People ask this because hs is peer-to-peer. The hub is only a choke point for one thing:
deciding when a land is final. The rest of the work doesn't go through it.

- **Work carries on while it's down.** Lands are still accepted, shared and checked by every
  peer, and teammates sync from each other's `hs watch` feeds. Starting a task still settles
  who leads it, peer to peer. Lands just stay _provisional_ and settle by themselves once the
  hub is back. With the hub down, a land takes about 1 s (`test/outage.js`), or about 7 s with
  20 writers (`test/outage-swarm.js`).
- **It's a notary, not a server.** The hub computes nothing: merges happen on the peer that
  proposes them, and every peer runs the same deterministic `apply` on every land. Blocks are
  signed by their authors and merkle-verified by whoever reads them, so the hub can't forge or
  change content. Its acks fix the order of lands. The worst a broken or hostile hub can do is
  stop acking, which stalls finality. It can't make a bad land valid.
- **Finality needs someone to decide.** During a network partition, no system can both keep
  accepting work and promise an order that will never change. Someone has to decide the
  order. The alternatives cost more:

  | who decides                       | cost                                           |
  | --------------------------------- | ---------------------------------------------- |
  | one hub (the default)             | finality waits while the hub is down           |
  | every writer (a repo with no hub) | one offline agent stalls finality for everyone |
  | a quorum of N nodes               | N always-on nodes and a consensus protocol     |
  | nobody                            | a "landed" change can be undone later          |

  [docs/FINALITY.md](docs/FINALITY.md) shows what goes wrong when this is fudged.

- **It's your team's peer, and you can replace it.** Git teams agree on one remote as the true
  main too. Here the team runs the hub on its own machine, and it can be replaced (below)
  without touching anyone's history.

What it does cost, plainly:

- In normal times the network is a star around the hub: each agent keeps one connection, to
  the hub, and task signals pass through it. A full mesh cost every agent memory for N²
  connections ([docs/DESIGN.md](docs/DESIGN.md) §7). Agents mesh with each other only while
  the hub is down.
- `land --wait-final`, `hs wait-final` and anything that waits for finality wait while the hub
  is down.
- During a network split, only the hub's side settles.
- If the hub's key is lost for good, the repo falls back to waiting for every writer, for good
  (see [Backups](#backups)).

### Setting it up

Create the hub with the repo. It can't be added later: only a weight-2 writer can grant the
weight a hub needs, and the throwaway writer that creates the repo hands that weight to the
hub and then deletes its own key.

```sh
hs init --as me --hub ../my-hub      # in your worktree: prints the invite
cd ../my-hub && hs seed --admit ../admit    # keep this running
```

Teammates then clone with `hs clone <invite> <dir> --as <handle> --admit ../admit`, and the
seed admits them by itself. The admit directory is a plain folder the clone drops its key into,
so it has to be one both can reach (the same machine, or a shared folder). Otherwise stop `hs seed` and
run `hs add-writer <key> --as <handle>` in the hub, with the key `hs info` prints in the
teammate's clone.

To run the hub on another machine, create it on the machine that runs `hs init`, then move the
directory while no `hs` command runs in it. Everything is under `<hub>/.hs/`, with paths
relative to the worktree. Moving a hub directory and seeding from its new place works (tested
on one machine). Delete the old copy once the new one runs: two copies of one hub must never
both write.

Never run `hs seed` in your own worktree. The hub has its own.

### Watching it

- `hs doctor` (in any worktree) shows how far main is settled, what each indexer has seen,
  and which settlement rule the repo is on.
- If lands stay unsettled for 20 s (`HS_HUB_STALL_S`), `hs status` and `hs land` print
  `!! hub not settling`, and feeds print `{"type":"hub","state":"stalled",...}`. They print
  `{"type":"hub","state":"settling",...}` when it's back.

### More holders, not more hubs

For more availability, add **holders**: an `hs seed` in a plain (non-indexer) worktree, or blind
peers (`hs blind-peer <key>`), which keep the repo encrypted and can't read it. Holders serve
everything, but their downtime never delays finality.

You can have more than one hub (`hs add-writer <key> --as <handle> --indexer`, run in the
hub), but each one is another thing finality waits for. A land settles only once **every**
hub has seen it, so if any hub is down, settlement stalls until it's back or removed, and
during a split neither side settles. Keep two only while you replace one, or as a deliberate
standby if losing the hub's key is a real risk. A blind peer can't be a hub: it has no writer
key and can't read what it stores.

### Replacing a hub

Only a live hub can make another one, so add the new hub before the old one goes:

```sh
hs clone <invite> new-hub --as hub2         # on the new machine; `hs info` prints its key
# in the old hub: stop `hs seed` (it locks the store), then
hs add-writer <new key> --as hub2 --indexer
hs seed                                     # restart it
# once the new hub runs `hs seed`
hs remove-writer hub
```

`hs remove-writer` is also how a team owner takes out a hub that's gone for good, but only
after a replacement has been added. Without a live hub nothing can grant weight 2 again, and
the repo falls back to every writer.

### Backups

The hub's data doesn't need a backup: holders, blind peers and teammates have copies of
everything landed, and a new hub fetches it again. What can't be replaced is the hub's key,
which lives in its store (`<hub>/.hs/store`).

A copy of the store isn't a safe way to bring a hub back, though. It falls behind as soon as
the hub acks again, and a hub run from a stale copy would write at positions in its log that
peers already hold, which forks its log. hs has no way yet to restore just the key.

So guard against losing the hub with a live replacement, not a backup:

- Replace a failing hub while it still runs (above), or keep a standby second hub if you
  accept that finality then waits for both.
- If the hub is lost with no replacement, the repo keeps working: lands settle once every
  writer has seen them, and `hs doctor` says so.

If you keep a copy of `<hub>/.hs/` anyway (to move a hub, say), stop `hs seed` first, since a
copy of an open RocksDB store may not be consistent. Keep it encrypted and offline: it holds
the hub's key. Never run it while the original might still be alive. Restoring a copy hasn't
been tested.

### Hosting many repos

One machine can hub many repos from one process: a **hub home**. It has one directory, one
store and one set of connections, so a teammate working on five of its repos needs one
connection to the host, not five. Each repo still has its own hub key, so finality,
replacing a hub and `hs doctor` work per repo exactly as above.

Run these on the hub's machine:

```sh
export HS_HUB_HOME=~/hubs              # or pass --home ~/hubs to each command
hs hubs new web-app --as me            # prints the invite; makes owners/web-app, your worktree
hs hubs serve                          # keep it running: hubs every repo in the home
hs hubs new api --as me                # while serving: the server makes it and serves it at once
hs hubs list                           # each repo's invite, main and how far it is settled
```

Teammates clone as usual and are admitted by themselves:
`hs clone <invite> <dir> --as <handle> --admit ~/hubs/admit/<repo>`. The admit directory is
on the hub's machine, so it has to be one both can reach.

What changes from one hub per repo:

- **One process hubs everything.** If it stops, every repo's lands stay provisional until it's
  back. Run it under a supervisor (systemd, launchd) that restarts it.
- **One store.** All the repos' hub data lives in `~/hubs/store`, one namespace each, so a
  single repo's hub can't be moved by copying a directory. Moving one in or out uses the
  replacement procedure (below).
- **Repos are made on the hub's machine,** because the hub has to be created with the repo.
  The owner's worktree starts in `owners/<repo>`; clone the repo elsewhere to work on it.
- **Not yet:** reclaiming a removed repo's space in the store, and blind peers for a home's
  repos.

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

## Commands

To explore them, run `hs --menu`: pick a command from a filterable list, fill a form built from
its flags (F1 explains the focused field; space on an empty path field opens a file or folder
picker), and it runs as the typed command would, printed so you learn it. `hs land --menu` opens one command's form directly; `hs <command> --help` has the
same descriptions and examples.

For the everyday loop there is `hs ui`, a lazygit-style terminal UI: Status, the files `land`
would send, the log, Review (your inbox and open asks) and Tasks (the board) on the left, the
selected diff on the right; `c` lands, `A` asks for review instead (pick reviewers from your
teammates), `p` syncs, `d` discards a file; in Review `a` approves, `x` asks for changes, `m`
comments; in Tasks `n` files a task, `s` starts it, `S` stops, `D` marks it done, `X` drops it;
`?` lists the keys. It runs its commands on worker
threads, exactly as typed. In Neovim, the lazyscion plugin opens it in a float, as lazygit.nvim does for lazygit.

Every command that talks to peers does so by default; `--offline` opts out. A land is
**provisional** until the hub acks it, then **settled** (it can't be reordered), then **final**
(settled and accepted by review). `land` waits up to 10 s for the hub, so it usually ends with
`#27 final`.

| command                                                                        | what                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `init [dir] [--as handle] [--encrypt]`                                         | create a repo                                                                                            |
| `clone <invite> [dir] [--as handle] [--admit dir] [--sparse p]…`               | join a repo, request write access, sparse checkout                                                       |
| `status`                                                                       | your edits, unlanded work, stale files, lands not yet final, reviews for you                             |
| `diff [--stat]`                                                                | what `land` would send, as a unified diff                                                                |
| `ui`                                                                           | a lazygit-style terminal UI: files, diffs, log, review inbox and tasks; land, ask, review, sync by key   |
| `land [-m msg] [--check cmd] [-r handles] [--ship] [--wait-final] [--offline]` | commit, pull, rebase if main moved, test the merge (`--check`), land, push, settle                       |
| `sync [--offline]`                                                             | bring main into your files and rebase your work onto it                                                  |
| `watch [--path p] [--count n] [--timeout s] [--for-me] [--json] [--stop]`      | stream lands, reviews and settlement as they happen                                                      |
| `log [path] [-n n] [--oneline]`, `show <n\|An> [--stat] [--path p]`            | history with files and states; a changeset or an ask with its diff                                       |
| `review` (alone: what waits on you), `review ask [-m] [-r handles] [-q n]`     | ask before landing (Ship / Show / Ask, see docs/AGENTS.md)                                               |
| `review approve\|changes\|comment <An\|n\|Tid> [-m]`, `review list [--all]`    | approve, submit feedback suggesting changes, or comment; every open ask                                  |
| `task` (the board), `task new\|split\|start\|stop\|done\|drop`                 | who builds what: start a task before building it (docs/TASKS.md)                                         |
| `ls [prefix]`, `cat <path>`                                                    | read main (or `--ws`, your workspace) without a checkout                                                 |
| `commit`, `restore <path…>`, `checkout [prefix…]`                              | checkpoint edits, discard edits, materialize files (optionally sparse)                                   |
| `export <dir> [--at n]`                                                        | write main as it was at changeset #n into a directory (like `git archive`)                               |
| `ws new\|switch\|list`                                                         | workspaces                                                                                               |
| `fetch`, `push`                                                                | download main without touching files; make sure a holder has your lands                                  |
| `seed [--admit dir] [--no-mirror] [--updates]`                                 | be the team's holder: stay online, hold everything, settle lands, admit writers                          |
| `hubs new\|serve\|list\|adopt\|add-writer\|remove` (`--home dir`)              | host many repos' hubs from one process (a hub home), and move hubs in and out                            |
| `info`, `doctor`, `add-writer <key> --as handle [--indexer]`                   | identity, connectivity and settlement, access                                                            |
| `remove-writer <handle or key>`                                                | take out a writer gone for good (a dead hub): settlement stops waiting for it; add its replacement first |
| `blind-peer <key> [--remove]`, `import-git <gitdir> [--branch] [--limit]`      | configure blind peers; replay a git branch's first-parent history                                        |

## Library

```js
const Corestore = require('corestore')
const Repo = require('hyperscion/lib/repo')

const repo = new Repo(new Corestore('./store'))
const ws = await repo.workspace('agent-42') // O(1) fork
await ws.commit([{ path: '/src/a.js', content: Buffer.from('...') }])
const { outcome } = await ws.land({ message: 'fix', rebase: 3 })
```

## Development

```sh
npm test                     # quick tier: in-process tests, about 25 s, no internet
npm run test:integration     # the real hs binary as many processes on local testnets, 4-7 min
npm run test:all             # both; scripts/test.js runs files in parallel (--jobs n)
npm run lint
npm run test:e2e -- [dir] [--encrypt]   # two worktrees over the public DHT (needs internet)
bare bench/commit.js 10000 100000
bare bench/land.js 4 200 50 3
bare bench/sparse.js 50000 100 1024
npm run make                 # standalone binary for this machine: out/make/hs
npm run make:linux-x64       # or for a given host: out/linux-x64/hs
npm run build                # pear deployment folder from out/<host>/hs: out/pear
pear stage <upgrade link> out/pear
```

`npm run build` stages a copy of package.json with `bin` set to `hs`: `pear install` fetches
one binary per `bin` key, and the real `bin` is the npm init installer.

`npm test` runs the quick tier and `npm run test:integration` the files `scripts/test.js` lists
as integration (each starts a hub, agents and feeds as separate processes). A new test file is
quick unless it's added to that list. Separately, tests come in three tiers by how much network
they need:

| tier             | what                                                                                                          | network                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| unit / library   | repo, workspace, merge, worktree, apply fuzz, watch, flip                                                     | in-process replication streams, nothing else           |
| peer integration | `test/net.js`, `test/blind-peer.js`, `test/cli.js` (the real `hs` binary as separate processes: hub + agents) | a private DHT testnet on loopback (`hyperdht/testnet`) |
| end to end       | `scripts/e2e.sh`                                                                                              | the public DHT                                         |

Set `HS_BOOTSTRAP=host:port` to point `hs` at a private DHT (`bare scripts/testnet.js` starts
one). On a loopback-only DHT, `hs` runs its node unfirewalled and bound to 127.0.0.1.

`vendor/hyperdrive` is hyperdrive PR #422 plus the patches listed in
[vendor/hyperdrive/PATCHES.md](vendor/hyperdrive/PATCHES.md).

The project is scaffolded from [hello-pear-bare](https://github.com/holepunchto/hello-pear-bare)
(Bare CLI builds and peer-to-peer OTA updates via `hs seed --updates`).

## License

Apache-2.0
