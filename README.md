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

With npm:

```sh
npm init hs
```

That's `npm init`, not `npm install`: npm runs the `create-hs` package, which fetches the `hs`
binary peer-to-peer with [pear-install](https://www.npmjs.com/package/pear-install) (what
`pear install` uses) and puts it in `~/.local/bin/hs` on macOS and Linux, or
`%LOCALAPPDATA%\Programs\hs\hs.exe` on Windows. `npm init -y hs` skips the question. The npm
package is only the installer (a few kB, no dependencies); the binary comes from peers.

Or with the [Pear CLI](https://install.pears.com):

```sh
pear install <the hs pear:// link>
```

## Quick start

```sh
npm install
alias hs="bare $PWD/bin.mjs"

mkdir demo && cd demo
hs init --as me              # prints the repo invite
echo hello > README.md
hs diff                      # what land would send
hs land -m "first"           # commit + land onto main
hs log

hs ws new feature            # O(1) fork of main
echo "hello world" > README.md
hs land -m "feature"
hs ws switch default && hs sync
```

For teams, and AI agents in particular, read **[docs/AGENTS.md](docs/AGENTS.md)**. It's the
playbook: watch instead of poll, sync, land small, learn from teammates' diffs. The binary
carries the agent instructions too: `hs agents` prints a short brief (docs/BRIEF.md),
`hs agents --full` the playbook, and `hs agents --write` saves the brief as `AGENTS.md` in the
worktree, where agent tools read it. To set up a
team with one command (an always-on holder plus N writable worktrees):

```sh
scripts/team.sh ./team 5      # hub runs `hs seed --admit`, agents in team/agents/a1..a5
```

Every team needs a **hub**: a worktree running `hs seed`. It is the repo's indexer: it keeps
landed work available when its author is offline, and it settles lands (see below). Create
it with the repo, `hs init --as me --hub ../my-hub`, so that a hub that dies for good can be
replaced (`hs add-writer <new> --indexer`, then `hs remove-writer hub`). A blind peer can
hold data too.

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

## Commands

To explore them, run `hs --menu`: pick a command from a filterable list, fill a form built from
its flags (F1 explains the focused field; space on an empty path field opens a file or folder
picker), and it runs as the typed command would, printed so you learn it. `hs land --menu` opens one command's form directly; `hs <command> --help` has the
same descriptions and examples.

Every command that talks to peers does so by default; `--offline` opts out. A land is
**provisional** until the hub acks it, then **settled** (it can't be reordered), then **final**
(settled and accepted by review). `land` waits up to 10 s for the hub, so it usually ends with
`#27 final`.

| command                                                                         | what                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `init [dir] [--as handle] [--encrypt]`                                          | create a repo                                                                                            |
| `clone <invite> [dir] [--as handle] [--admit dir] [--sparse p]…`                | join a repo, request write access, sparse checkout                                                       |
| `status`                                                                        | your edits, unlanded work, stale files, lands not yet final, reviews for you                             |
| `diff [--stat]`                                                                 | what `land` would send, as a unified diff                                                                |
| `land [-m msg] [--check cmd] [-r handles] [--ship] [--wait-final] [--offline]`  | commit, pull, rebase if main moved, test the merge (`--check`), land, push, settle                       |
| `sync [--offline]`                                                              | bring main into your files and rebase your work onto it                                                  |
| `watch [--path p] [--count n] [--timeout s] [--for-me] [--json] [--stop]`       | stream lands, reviews and settlement as they happen                                                      |
| `log [path] [-n n] [--oneline]`, `show <#n\|Pn> [--stat] [--path p]`            | history with files and states; a changeset or proposal with its diff                                     |
| `propose [-m] [-r handles] [-q n]`, `review <Pn\|#n> approve\|changes\|comment` | Ask and review (Ship / Show / Ask, see docs/AGENTS.md)                                                   |
| `proposals [--all]`                                                             | open proposals: waiting for you, yours                                                                   |
| `ls [prefix]`, `cat <path>`                                                     | read main (or `--ws`, your workspace) without a checkout                                                 |
| `commit`, `restore <path…>`, `checkout [prefix…]`                               | checkpoint edits, discard edits, materialize files (optionally sparse)                                   |
| `export <dir> [--at n]`                                                         | write main as it was at changeset #n into a directory (like `git archive`)                               |
| `ws new\|switch\|list`                                                          | workspaces                                                                                               |
| `fetch`, `push`                                                                 | download main without touching files; make sure a holder has your lands                                  |
| `seed [--admit dir] [--no-mirror] [--updates]`                                  | be the team's holder: stay online, hold everything, settle lands, admit writers                          |
| `info`, `doctor`, `add-writer <key> --as handle [--indexer]`                    | identity, connectivity and settlement, access                                                            |
| `remove-writer <handle or key>`                                                 | take out a writer gone for good (a dead hub): settlement stops waiting for it; add its replacement first |
| `blind-peer <key> [--remove]`, `import-git <gitdir> [--branch] [--limit]`       | configure blind peers; replay a git branch's first-parent history                                        |

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
npm test                     # everything below except the public-DHT e2e, ~40 s, no internet
npm run lint
npm run test:e2e -- [dir] [--encrypt]   # two worktrees over the public DHT (needs internet)
bare bench/commit.js 10000 100000
bare bench/land.js 4 200 50 3
bare bench/sparse.js 50000 100 1024
npm run make                 # standalone binary for this machine: out/make/hs
npm run make:linux-x64       # or for a given host: out/linux-x64/hs
```

Tests come in three tiers, by how much network they need:

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
