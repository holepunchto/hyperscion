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

Collaborating across machines:

```sh
# machine A
hs seed --mirror             # stay online and hold all landed content

# machine B
hs clone <invite> work --sparse src   # only materialize src/
cd work && hs info                     # copy the writer key

# machine A (stop seed first; one process per store)
hs add-writer <writer-key>

# machine B
hs pull && hs land --online -m "my change"
```

`hs init --encrypt` encrypts all repo data at rest. The invite then carries the key.

## Commands

|                                               |                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `init [dir] [--encrypt]`                      | create a repo                                                    |
| `clone <invite> [dir] [--sparse p]…`          | join a repo, sparse checkout                                     |
| `status`, `diff`, `commit`                    | working copy vs workspace                                        |
| `land [-m] [--online]`                        | commit and land onto main (provisional until all writers see it) |
| `sync`                                        | rebase onto main, 3-way merging overlapping files                |
| `log [path]`, `ls [prefix]`, `cat <path>`     | read main (no checkout needed)                                   |
| `checkout [prefix…]`                          | materialize files, optionally sparse                             |
| `ws new\|switch\|list`                        | workspaces                                                       |
| `info`, `add-writer <key> [--indexer]`        | identity and access                                              |
| `pull`, `push`, `seed [--mirror] [--updates]` | networking                                                       |
| `blind-peer <key> [--remove]`                 | configure blind peers                                            |
| `import-git <gitdir> [--branch] [--limit]`    | replay a git branch's first-parent history                       |

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
