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
- **Data stays available without a server.** Mirror peers (`hs seed --mirror`) or blind peers
  that hold encrypted blocks they cannot read.

This is a milestone-1 prototype. **[docs/DESIGN.md](docs/DESIGN.md)** has the architecture, the
Scion mapping, the measured results (including where git still wins) and the open problems.

## Quick start

```sh
npm install
alias hs="bare $PWD/bin.mjs"

mkdir demo && cd demo
hs init                      # prints the repo invite
echo hello > README.md
hs land -m "first"           # commit + land onto main
hs log

hs ws new feature            # O(1) fork of main
echo "hello world" > README.md
hs land -m "feature"
hs ws switch default && hs sync
```

For teams, and AI agents in particular, read **[docs/AGENTS.md](docs/AGENTS.md)**. It's the
playbook: watch instead of poll, sync, land small, learn from teammates' diffs. To set up a
team with one command (an always-on holder plus N writable worktrees):

```sh
scripts/team.sh ./team 5      # hub runs `hs seed --mirror --admit`, agents in team/agents/a1..a5
```

Every team needs a **holder**: a hub running `hs seed --mirror`, or a blind peer. It keeps
landed work available when its author is offline.

Collaborating across machines by hand:

```sh
# machine A
hs seed --mirror             # stay online and hold all landed content

# machine B
hs clone <invite> work --sparse src   # only materialize src/
cd work && hs info                     # copy the writer key

# machine A: admit without stopping the seed (`hs seed --mirror --admit ./admit`, and clone
# with `hs clone <invite> --admit ./admit`), or stop the seed and:
hs add-writer <writer-key>

# machine B
hs pull && hs land --online -m "my change"
```

`hs init --encrypt` encrypts all repo data at rest. The invite then carries the key.

## Commands

|                                                    |                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `init [dir] [--encrypt]`                           | create a repo                                                                    |
| `clone <invite> [dir] [--sparse p]… [--admit dir]` | join a repo, sparse checkout, request write access                               |
| `status`, `diff`, `commit`, `restore <path…>`      | working copy vs workspace; discard local edits                                   |
| `land -o [-m]`                                     | commit and land onto main; auto-rebases on conflict; waits until a holder has it |
| `sync [--offline]`                                 | pull main and rebase onto it (3-way merge, union merge per `.hsattributes`)      |
| `watch [--path p] [--count n] [--json] [--patch]`  | stream changesets (and reorgs) as they land                                      |
| `show <n> [--stat]`                                | a changeset's message and unified diff                                           |
| `log [-f] [path]`, `ls [prefix]`, `cat <path>`     | read main (no checkout needed)                                                   |
| `checkout [prefix…]`                               | materialize files, optionally sparse                                             |
| `ws new\|switch\|list`                             | workspaces                                                                       |
| `info`, `add-writer <key> [--indexer]`             | identity and access                                                              |
| `pull`, `push`, `doctor`                           | fetch, upload, check connectivity and holder                                     |
| `seed [--mirror] [--admit dir] [--updates]`        | stay online as the team's holder                                                 |
| `blind-peer <key> [--remove]`                      | configure blind peers                                                            |
| `import-git <gitdir> [--branch] [--limit]`         | replay a git branch's first-parent history                                       |

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
npm test                     # brittle-bare: spikes, repo, worktree, net, fuzz, import
npm run lint
scripts/e2e.sh [dir] [--encrypt]   # two worktrees over the public DHT
bare bench/commit.js 10000 100000
bare bench/land.js 4 200 50 3
bare bench/sparse.js 50000 100 1024
npm run make:linux-x64       # standalone binary: out/linux-x64/hyperscion
```

Set `HS_BOOTSTRAP=host:port` to use a private DHT (`bare scripts/testnet.js` starts one).

`vendor/hyperdrive` is hyperdrive PR #422 plus the patches listed in
[vendor/hyperdrive/PATCHES.md](vendor/hyperdrive/PATCHES.md).

The project is scaffolded from [hello-pear-bare](https://github.com/holepunchto/hello-pear-bare)
(Bare CLI builds and peer-to-peer OTA updates via `hs seed --updates`).

## License

Apache-2.0
