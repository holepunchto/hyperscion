# hyperscion design

hyperscion is a peer-to-peer source control system for agent-scale change volume, built on
hyperbee2, autobee, hyperdrive (PR #422) and blind peers, shipped as a Bare CLI (`hs`).

It is a response to Anthropic's [Scion](https://www.anthropic.com/engineering/redesigning-source-control),
which replaced git for a monorepo landing 30k changes a day from mostly AI agents. Scion's
answer is centralized: an authoritative server tier that computes commits, merges and derived
data, regional caches, and per-node daemons. hyperscion asks how much of that the Holepunch
stack already provides without a server, and measures where it falls short.

Status: milestone 1 prototype. Everything below marked _measured_ is reproducible with the
scripts in `bench/` and `scripts/e2e.sh`.

## 1. Scion's ideas and their hyperscion counterparts

| Scion                                                                       | hyperscion                                                                                                                                    | Status                                                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Changeset = WAL entry, delta vs. parent                                     | A hyperbee2 batch appended to a workspace's own hypercore; a flush rewrites only the dirty root-to-leaf path                                  | measured: 1 tree block per 1-file commit at 10k and 100k paths                    |
| Cost proportional to change, not repo                                       | Same, by construction of the copy-on-write B-tree                                                                                             | measured: flat for local edits; random edits pay cold-read cost (§7)              |
| Cheap branches                                                              | **Cross-core fork**: a workspace's first batch is rooted at main's `(viewCoreKey, length)`; untouched subtrees stay pointers into main's core | measured: fork 1.3 ms at 100k paths (`git worktree add`: 1.2 s)                   |
| Refs are the only shared mutable state; CAS on one row; no merge-queue lock | Main is an **autobee**; a `land` op is accepted or rejected deterministically in `apply` by path-level optimistic concurrency                 | measured: 500 workspaces / 4 writers converge, identical hash chain on every peer |
| Derived data computed recursively from parents                              | Path index, path history, changeset log and content-hash index maintained inside `apply`, cost proportional to the land                       | working: `hs log <path>` is one range read                                        |
| Content-addressed immutable objects, cacheable anywhere                     | Hypercore blocks are immutable and merkle-verified, so any peer or cache can serve them and none can lie                                      | working                                                                           |
| Lazy, on-demand fetch                                                       | Sparse hypercore replication: a peer fetches exactly the blocks it reads                                                                      | measured: 100 of 50,000 blob blocks fetched for a one-directory checkout          |
| scion-cache / scion-server tiers, >99% hit rate                             | **Blind peers** (hosted, encrypted at rest, untrusted) and **mirror peers** (`hs seed --mirror`, self-hosted)                                 | mirror and blind peer: tested (encrypted repo readable after its author leaves)   |
| Daemon boots from a periodic snapshot                                       | autobee **fast-forward**: boot from a writer's stamped view head instead of replaying the oplog                                               | measured: a fresh peer fetched 12 of 100 oplog blocks                             |
| API-only access, no checkout needed                                         | `hs ls`, `hs cat`, and the library API (`Repo`, `Workspace`) need no working copy                                                             | working                                                                           |
| Sparse / virtual checkouts                                                  | `hs checkout <prefix>…` materializes only those prefixes; no virtual FS yet                                                                   | working                                                                           |
| Directory-level ACLs                                                        | Not designed yet                                                                                                                              | open                                                                              |

### Where the analogy breaks

- **No server computes anything.** Blind peers only store and serve encrypted blocks. Merges
  and rebases happen on the proposing peer; `apply` only _validates_ them deterministically.
  Every peer applies every land, so each peer is a full "server" for main's metadata, though
  not for content.
- **Hypercore addresses blocks by position, not by content.** Content addressing is an index
  (`hs-hash/<blake2b>` → entry) maintained in `apply`, plus a `hash` field on every file entry.
- **There is no global CAS, only a deterministic order.** Autobee linearizes concurrent ops,
  and a reorg can reorder them later. A locally accepted land is therefore **provisional**
  (§4.3).
- **Blind peers download whole cores eagerly and garbage-collect whole cores.** Data is split
  across many cores (one tree core and one blobs core per workspace) so replication and GC
  granularity stay manageable.

### Why not "gear v2"

gip/gear (git on hypercore) shows what to avoid:

- a single writer;
- a fetch that downloads the whole core;
- re-indexing every path on every push;
- no "haves";
- git objects stored one by one.

hyperscion has no git object model inside; git is only an import source.

## 2. Data model

A repo is one corestore namespace:

```
main (autobee)          writers' oplogs + per-writer view cores (hyperbee2)
  view keyspaces:
    files/<path>        hyperdrive entry: {executable, linkname, blob:{…, core}, metadata, hash}
    hs-paths/<path>     {seq}: last changeset that touched the path   (conflict detection)
    hs-hist/<path>\0<seq>                                              (path history)
    hs-cs/<seq>         changeset: {seq, hash, writer, node, ws, base, paths, message, author, time, blobs}
    hs-ops/<writer><n>  outcome of every op: accepted | conflict | stale-base | invalid
    hs-hash/<blake2b>   first entry seen with that content                (dedup)
    hs-meta/main        {seq, hash}: head of the changeset hash chain

per workspace
  tree core (hyperbee2) first batch rooted in main's view core (cross-core fork)
  blobs core (hyperblobs)
```

The view's `files/` keyspace has exactly Hyperdrive's layout, so main _is_ a drive. You can
read it through Hyperdrive, mirror it with mirror-drive, and so on. All records are
hyperschema-encoded (`lib/schema/spec`, append-only versioning).

A changeset id is `(seq, hash)`, where
`hash = blake2b(previousHash ‖ landOpBytes)`. It is computed from op bytes only, never from
view block positions, so it is identical on every peer even though each peer writes its view
blocks into its own core.

## 3. Workspaces, commits and forks

`repo.workspace(name)` creates a tree core and a blobs core, and **moves** the tree's root to
main's current view head: `bee.move({ key: viewCoreKey, length })`. That is the whole fork.
hyperbee2 writes a batch's dirty nodes into the bee's _local_ core and rewrites pointers to
untouched subtrees as `(coreIndex, seq, offset)` into the foreign core
(`hyperbee2/lib/write.js`, `_flush` and `prepareCohorts`).

- **Fork** is O(1): no blocks are written.
- **Commit** of k files appends O(k · depth) nodes; at t = 128 one block holds them for small k.
- **Diff** against the fork point (`createDiffStream`) skips identical subtree pointers, so it
  costs O(changed paths).
- Before uploading, a commit hashes each file and checks `hs-hash`. Content already on main is
  referenced, not re-uploaded (_measured_: 0 bytes uploaded for a 256 KB file already landed
  elsewhere).

Workspace state (fork point, base, current root, last land and pre-land state) lives in the
local writer core's user data, not on the wire.

## 4. Landing (lock-free)

### 4.1 The land op

```
land { ws:{key,length}, base:{seq,hash}, entries:[{path, value|null}], message, author, time, blobs }
```

Entries are inlined hyperdrive entry encodings. They carry blob pointers plus `blob.core`, not
content, so `apply` does **no foreign I/O**. One op travels in one autobee node (one hypercore
block, about 15 MiB max). The importer and other bulk writers split anything larger than 20k
paths into consecutive changesets. Fuzzing confirms a 20k-entry land applies fine.

### 4.2 apply (`lib/apply.js`)

`apply` is total. A throw in an autobee `apply` closes the database, so every outcome,
including garbage, is written to `hs-ops/` rather than thrown. A fuzz test feeds it random
bytes, 300 mutated valid ops per run, and every hostile shape we could think of. The fuzzer
found one real crash (an absent optional array decoding as `null`), which is now fixed.

For each land:

1. **Base check.** `base.seq ≤ meta.seq` and `cs[base.seq].hash == base.hash`, otherwise
   `stale-base`. This replaces the plan's "fork from the acked view head": autobee has no
   notion of an acked or confirmed view, so the base must verify itself instead.
2. **Validation.** Paths must be normalized and unique, entries must decode, and blobs must
   name their core. Otherwise `invalid`.
3. **Conflict check.** If any path has `hs-paths[p].seq > base.seq`, the result is `conflict`,
   listing the paths.
4. **Accept.** `seq++` and extend the hash chain. Write the entries, `hs-paths`, `hs-hist`,
   `hs-cs` and `hs-hash`.

Ops are only processed from added writers (`optimistic: false`). An `add-writer` op from an
existing writer calls `host.addWriter`.

### 4.3 Provisional outcomes and recovery

Autobee orders concurrent ops by weight and causality, and a later-arriving node can reorder
history (an O(1) `move` of the view root). A land that a writer applied locally as `accepted`
can therefore become `conflict` once a concurrent land from a heavier writer arrives. Spike C
reproduces exactly this: two offline writers both accept their own edit to `/a.txt`, then
converge on one winner after reconnecting.

There is no finality signal in autobee today. In hyperscion:

- `hs land` reports "accepted (provisional)".
- `hs status` re-reads the last land's outcome from `hs-ops`.
- Before a land, the workspace records its pre-land root, fork and base. If `sync` finds the
  land flipped, it moves the fork point back and rebases normally, so commits made after the
  land survive. Known limitation: changes by other writers that were in main when we
  auto-synced, and that also flipped later, would be replayed as ours. Tested: the losing writer's change
  is restored, 3-way merged and re-landed.

A land is final once every writer has an oplog node causally after it. Computing and exposing
that ("settled") is the most important open item (§8).

### 4.4 Sync and rebase (client side)

`ws.sync()` re-forks onto main's head. It replays non-overlapping paths directly, 3-way merges
overlapping text files (diff3, `lib/merge.js`), and writes conflict markers otherwise. Only
the paths the workspace touched are compared, by point lookups rather than a whole-tree diff.

`land({ rebase: n })` does what a server-side merge queue would: on `conflict` or `stale-base`
it syncs, and if the merge is clean it lands again, up to n times. In the landing benchmark
this raises first-round success from 4/20 to 18/20 in the small configuration, and to 186/200
at 4 writers / 200 workspaces.

## 5. Networking and availability

- **Swarm.** Hyperswarm on main's discovery key, with `store.replicate` per connection.
  One-shot commands (`clone`, `pull`, `push`, `land --online`) join **client-only**; only
  `hs seed` announces. On localhost testnets, two short-lived peers that both announced and
  dialed hit a simultaneous-dial race in which one side never registered the connection.
  Making ephemeral peers client-only removes that race and matches their role anyway.
- **Lazy content.** Readers fetch blob blocks on demand. When content isn't held by any online
  peer, `hs checkout` and `hs sync` report the missing files and exit with status 2. Without
  this check, Bare drained its event loop with a pending promise and exited 0 with a stale
  working copy, which is how the bug showed up in the first e2e run. `bin.mjs` also guards
  against any such stall.
- **Who holds what.** Other peers replicate a writer's oplog eagerly. Workspace trees and blobs
  are fetched lazily, so **content needs a holder after its author goes offline**:
  - `hs seed --mirror` downloads every landed workspace's tree and blobs core **and every
    writer's view core**. The view cores matter because autobee views share subtrees across
    writers' view cores. A star-topology landing benchmark hung where a full mesh did not,
    most likely while reading view blocks that only an unreachable writer held. The exact
    blocks were not traced.
  - Blind peers fill the same role as a hosted service: `addAutobase` for main, `addCore` for
    workspace cores, priority 1 once landed and 0 before. _Tested_ with an in-process
    blind-peer: it holds an encrypted repo's oplog, tree and blobs as ciphertext and serves a
    fresh peer after the author left (`test/blind-peer.js`). Note that blind peers downgrade `announce: true` unless they trust
    the client, so discovery for `hs clone` also needs a seed online or trusted blind peers.
- **Encryption.** `hs init --encrypt` creates a repo-wide key. The invite
  (`<repoKey>.<encryptionKey>`) carries it. Autobee's per-core view encryption provider is used
  for every core a tree traverses, including workspace cores (created with v3 manifests, which
  it requires) and blobs cores. _Tested_: blobs are not plaintext at rest, and two peers clone,
  read and land encrypted over a DHT testnet and over the public DHT (`scripts/e2e.sh … --encrypt`).

## 6. CLI, process model, git import

- `hs` is a paparam CLI (`lib/cli.js`). Commands run in-process against `.hs/store`.
- One process per `.hs` store, because RocksDB takes a lock. Running `hs seed` therefore blocks
  other commands in that worktree. A Scion-style per-machine daemon (one store and one warm
  cache serving many worktrees and agents over IPC) is the next milestone. It is also the fix
  for cold-read latency (§7).
- The hello-pear-bare OTA updater runs only under `hs seed --updates`, and only with a real
  `pear touch` upgrade link. One-shot commands never update mid-flight.
- `hs import-git` replays `rev-list --first-parent --reverse` using `diff-tree` and a single
  long-lived `cat-file --batch`, keeping author, time and message. It skips symlinks and
  submodules.

## 7. Measured results

Machine: AMD Ryzen AI 9 HX 370 (24 threads), 23 GB RAM, tmpfs, Bare 1.35.0, git 2.56.0. All
peers in the landing and sparse benchmarks run **in one process** over in-memory streams, so
those numbers exclude network latency and include every peer's CPU work on one event loop.

### Commit, fork, diff (`bare bench/commit.js 10000 100000`)

hyperscion runs in API mode with caches cold at the start. git uses a working tree.

| paths   | fork   | commit 1 (random) | commit 100 (random) | commit 100 (one dir) | diff 100 | land 100 | blocks / commit | read cold | read warm | git commit 1 | git worktree add |
| ------- | ------ | ----------------- | ------------------- | -------------------- | -------- | -------- | --------------- | --------- | --------- | ------------ | ---------------- |
| 10,000  | 1.66ms | 1.28ms            | 21.7ms              | 15.7ms               | 2.25ms   | 12.2ms   | 1               | 0.19ms    | 0.01ms    | 94.1ms       | 135.7ms          |
| 100,000 | 1.29ms | 10.1ms            | 372.3ms             | 17.9ms               | 2.04ms   | 40.1ms   | 1               | 8.13ms    | 0.01ms    | 131.7ms      | 1226.8ms         |

What these numbers show:

- **Flat as the tree grows:** fork, diff, blocks per commit, and commits of related files
  (one directory).
- **Grows with the tree:** commits that touch random files across the tree. The cause is
  hyperbee2 _cold_ reads, which go from 0.19 ms to 8.1 ms per lookup while warm reads stay at
  0.01 ms. A hyperbee2 node holds pointers to keys that live in whichever blocks wrote them, so
  cold-inflating a 255-key leaf can touch many blocks.
  - The effect is the same on main's own view, so it is not caused by forking.
  - A long-lived daemon with warm caches hides it.
  - Compacting the view, or keeping keys inline with their leaf, would fix it. That needs to
    go to the hyperbee2 maintainers.
- **Not comparable:** `git branch` is also O(1), and `git diff` also skips unchanged trees. The
  git columns are the closest analogs that produce an isolated, writable tree (`worktree add`)
  and a durable commit.
- **1M paths: not completed.** Process RSS passed 10 GB while seeding and benchmarking a
  1M-path tree. Memory grew about 70 MB per 20k-entry land, which is consistent with per-bee
  node caches (4096 nodes of up to 255 keys each, across several bee instances) plus retained
  oplog nodes. This needs profiling before claims at that scale.

### Lock-free landing (`bare bench/land.js <writers> <workspaces> <hot> <rebase>`)

Each workspace edits 2 lines in 2 of the `hot` shared 400-line files, plus one file of its
own. The table records first-round outcomes (accepted/conflict/stale-base), then the rounds
until every workspace landed. Every run converged to an identical hash chain on all peers,
with every agent's file present.

| writers | workspaces | hot files | rebase | 1st round a/c/s                    | rounds | land attempts | time            | accepted/s |
| ------- | ---------- | --------- | ------ | ---------------------------------- | ------ | ------------- | --------------- | ---------- |
| 2       | 20         | 10        | 0      | 4/16/0                             | 7      | 64            | 1.86s           | 10.7       |
| 2       | 20         | 10        | 3      | 18/2/0                             | 2      | 42            | 1.03s           | 19.5       |
| 2       | 100        | 100       | 3      | 97/2/1                             | 2      | 183           | 6.49s           | 15.4       |
| 4       | 100        | 100       | 3      | 96/2/2                             | 2      | 185           | 8.72s           | 11.5       |
| 10      | 100        | 100       | 3      | 80/2/18                            | 3      | 216           | 54.19s          | 1.8        |
| 4       | 200        | 50        | 3      | 186/5/9                            | 3      | 432           | 21.35s          | 9.4        |
| 4       | 500        | 100       | 3      | 446/35/19                          | 4      | 1107          | 60.82s          | 8.2        |
| 4       | 200        | 50        | 0      | ~20 accepted per round             | >7     | —             | >250s (stopped) | ~4         |
| 10      | 500        | 100       | 3      | did not finish round 1 within 580s |        |               |                 |            |

- No merge queue and no lock. Throughput is bounded by apply and reorg work, and **degrades
  with writer count**: each extra writer adds a full copy of every apply and reorg replay to
  the same CPU in this single-process setup, and adds more concurrent reorderings. A
  multi-process, multi-machine run is needed before drawing conclusions about writer scaling.
- For scale: Scion's 30k merges a day is 0.35/s.
- Writer cardinality matters by design. Peers are writers and workspaces are cheap, so 500
  agents on 5 machines means 5 writers.

### Sparse fetch for one directory (`bare bench/sparse.js 50000 100 1024`)

The repo has 50,000 files of 1 KB each in 500 directories (51 MB of content), landed as 100
changesets of 500 files.

|                                   | full clone | sparse peer received | sparse checkout |
| --------------------------------- | ---------- | -------------------- | --------------- |
| hyperscion                        | 97.3 MB    | **4.0 MB**           | 356 ms          |
| git `--filter=blob:none --sparse` | 30.5 MB    | **1.3 MB**           | 271 ms          |

Breakdown of what the hyperscion peer fetched:

|                  | blocks fetched                                | data       |
| ---------------- | --------------------------------------------- | ---------- |
| writer oplog     | 12 of 100 (autobee fast-forwarded on its own) | 668 KB     |
| content          | exactly 100 of 50,000 blob blocks             | 102 KB     |
| main's view tree | 362 of 4,041 blocks                           | **3.1 MB** |

With an explicit fast-forward boot head, the oplog cost drops to 1 block (56 KB) and the total
to 3.4 MB.

**git wins this one today.** Content fetch is exact and fast-forward works, but reading one
directory's entries pulls 3.1 MB of tree blocks. That is the same key-scatter effect as the
cold reads above. Two further costs: git compresses (zlib) and hyperscion does not, and every
version of a file is stored whole.

### Import (`hs import-git`)

holepunchto/hypercore, 2,060 first-parent commits:

- **Time:** 2,058 changesets in 51.1 s.
- **Content:** every file at HEAD is byte-identical to git (100 files), and path history
  matches `git log --first-parent -- <path>`.
- **Storage:** 83 MB store against git's 13 MB `.git`. There is no delta compression or
  packing, so all 77 MB of raw blob versions are kept.

### End to end

`scripts/e2e.sh [dir] [--encrypt]` runs two worktrees over the **public DHT**:

1. A inits, lands, and runs `seed --mirror`.
2. B clones sparsely, gets added as a writer, and runs `land --online`.
3. A syncs B's change after B has gone offline.

It passes both unencrypted and encrypted.

## 8. Open problems and next steps

1. **Settlement / finality.** Expose "settled" once every writer has a node causally after the
   land, and make `hs land --wait-settled` the default for agents.
2. **Daemon.** One store per machine, warm caches, an IPC API for many worktrees and agents.
   This is also the fix for cold reads and for the RocksDB single-process limit.
3. **Tree-read amplification and memory in hyperbee2.** Take the cold-read and sparse-listing
   findings, and the 1M-path RSS growth, to the hyperbee2 maintainers. Candidates: view
   compaction (autobee has `compactMaybe`), inline keys, bounded-bytes node caches.
4. **Blind peers at scale.** Basic hold-and-serve is tested; still to check: GC of unlanded
   workspaces under storage pressure, and a team that relies on blind peers alone.
5. **Compression and deltas.** Per-blob compression, maybe chunked dedup for large files.
6. **Writer scaling.** Multi-process and multi-machine landing benchmarks, and profiling of the
   reorg and apply cost per writer.
7. **Server-side derived data, kept in reserve.** Blame and code search need more than
   `apply` should do. A custom indexer peer (a P2P service building derived views from main)
   is the escape hatch if client-side derivation gets too heavy.
8. Virtual file system, directory ACLs, pairing UX for `add-writer`, and a bidirectional git
   bridge.

## 9. Milestone 2: what experiment 1 changed

In experiment 1, five agents built a project together through `hs` and rated it 2/5 against
git. They liked the model (lock-free per-file lands, `log -f` as a feed, fast feedback loops)
but hit availability and safety bugs. Milestone 2 turns those into rules.

- **`pull` makes main local for your sparse set.**
  - `Workspace.prefetch` lists every sparse prefix in both main and the workspace, which
    fetches every tree block on the way.
  - It downloads every missing blob, plus the fork-point versions of paths the workspace
    changed (merge inputs).
  - Afterwards `status`, `diff`, `checkout`, `cat` and local `sync` never touch the network.
  - `sync` is online by default. `cat` and `show` read locally first and go online only on a
    miss.
- **Reads time out instead of stalling.** Workspace reads go through `ws.io`: wait forever for
  library users, `{ timeout }` when online, `{ wait: false }` offline. A miss throws
  `ContentUnavailableError` before the root moves, so a rebase is never half-applied. The CLI
  turns it into "start a holder". Bare's drained-event-loop stall is still caught and traced as
  a last resort.
- **Stale is never an edit.**
  - A file whose new version couldn't be fetched is marked stale in the stat cache.
  - `status` lists it separately, and `commit` excludes it. Edits on top of it are held back
    (`modified (stale base)`), and `land` refuses while they exist.
  - `checkout` never overwrites a locally edited file; `hs restore` does that on request.
  - This closes the near-silent revert three agents hit.
- **A land isn't done until a holder has it.**
  - `land -o` and `push` wait until a peer holds the oplog _and_ the landed workspace's tree
    and blobs.
  - The second experiment's dry run showed why: a one-shot `land -o` exited before the hub
    mirror had downloaded its content, leaving it only on the author's machine.
- **Every team has a holder.** `hs seed --mirror` on a hub (now also mirroring every writer's
  view core) or a blind peer. `hs seed --admit <dir>` admits writers without taking the holder
  offline. `scripts/team.sh` sets a team up, and `hs doctor` checks it.
- **Flips are loud.** `pull`, `sync`, `status` and `land` repeat a banner until `sync` restores
  the land. `hs watch` reports reorgs.
- **Lands rebase themselves.** `land -o` retries up to 3 times: pull, prefetch, sync, land. The
  loop lives in the CLI so each retry fetches what the newer land needs. Paths marked
  `merge=union` in `/.hsattributes` (e.g. NOTES.md) merge without markers.
- **Watch, don't poll.** `hs watch` streams changesets (`--json`, `--path`, `--count 1` to wait
  for a dependency, `--patch` for diffs) from its own observer store, so it runs next to other
  `hs` commands. `hs show <n>` diffs a changeset using before/after entry values that `apply`
  now records per path.
- **Agent playbook.** `docs/AGENTS.md` replaces ad-hoc instructions.

Known costs:

- Online commands pay ~2–3 s of DHT connect each, and `sync` is now online.
- `watch` adds a second RocksDB store per worktree.
- `apply` does one extra lookup per landed path for the history values.
- A shared per-machine daemon would remove the first two.
