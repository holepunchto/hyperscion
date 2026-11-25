# Development

## Tests, benchmarks and builds

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

`npm run build` stages a copy of package.json for Pear: `pear install` fetches one binary per
`bin` key, and the only one is `hs`. The package is private: hs is distributed through Pear and
source builds, never published to npm.

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
[vendor/hyperdrive/PATCHES.md](../vendor/hyperdrive/PATCHES.md).

The project is scaffolded from [hello-pear-bare](https://github.com/holepunchto/hello-pear-bare)
(Bare CLI builds and peer-to-peer OTA updates via `hs seed --updates`).

## Library

From a checkout (hs isn't published to npm):

```js
const Corestore = require('corestore')
const Repo = require('./lib/repo')

const repo = new Repo(new Corestore('./store'))
const ws = await repo.workspace('agent-42') // O(1) fork
await ws.commit([{ path: '/src/a.js', content: Buffer.from('...') }])
const { outcome } = await ws.land({ message: 'fix', rebase: 3 })
```
