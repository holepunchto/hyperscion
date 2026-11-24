# The hub

Every team repo has a hub. It's the closest thing hs has to git's shared remote, with two jobs:

- **It makes lands final.** Once the hub has seen a land, the land's place in main's history is
  fixed (_settled_), and nothing can reorder or undo it.
- **It holds everything landed,** so teammates can fetch your work after your machine goes
  away. With `--admit <dir>` it also lets new writers in.

## Seeds and the hub

**Seeding** a repo means staying online to hold and serve its data, as in BitTorrent. `hs seed`
seeds the repo of the worktree it runs in.

- Run in the **hub's worktree** (the one `hs init --hub` made), `hs seed` also settles lands.
  That's what makes it the hub. One repo has one hub.
- Run in **any other worktree** (a clone made just for it), `hs seed` is an extra seed. It
  holds and serves everything, which supports the hub: teammates can still fetch work while
  the hub is down. It doesn't settle anything, so its downtime never delays a land.
- **Blind peers** (`hs blind-peer <key>`) support the hub the same way, as a hosted service.
  They store the repo encrypted and can't read it, which holds because repos are encrypted
  by default. A repo made with `--no-encrypt` is readable by any peer holding its blocks.
- A teammate's running `hs watch` keeps a copy too, while it runs.

Never run `hs seed` in the worktree you work in. It keeps the worktree busy, and the hub or an
extra seed has a directory of its own.

## Running it

```sh
hs init --as me --hub ../my-hub             # in your worktree: prints the invite
cd ../my-hub && hs seed --admit ../admit    # keep this running
```

Teammates clone with `hs clone <invite> <dir> --as <handle> --admit ../admit`, and the hub
admits them by itself. The admit directory is a plain folder the clone drops its key into, so
it has to be one both can reach (the same machine, or a shared folder). **Anyone who can write
a key into it gets write access**, so keep it private to the team. Otherwise stop
`hs seed` and run `hs add-writer <key> --as <handle>` in the hub, with the key `hs info`
prints in the teammate's clone.

### Running the hub elsewhere

The hub is made on the machine that runs `hs init`. To run it on another machine, stop
`hs seed`, then copy the hub directory there and run `hs seed` in it. Everything is under
`<hub>/.hs/`, with paths relative to the worktree. Moving a hub directory and seeding from its
new place works (tested on one machine). Delete the old copy once the new one runs: two copies
of one hub must never both write.

### Watching it

- `hs doctor` (in any worktree) shows how far main is settled, what each indexer has seen,
  and which settlement rule the repo is on.
- If lands stay unsettled for 20 s (`HS_HUB_STALL_S`), `hs status` and `hs land` print
  `!! hub not settling`, and feeds print `{"type":"hub","state":"stalled",...}`. They print
  `{"type":"hub","state":"settling",...}` when it's back.

## Isn't a hub a central point of failure?

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

  [Finality](FINALITY.md) explains what the hub's ack guarantees, and why.

- **It's your team's peer, and you can replace it.** Git teams agree on one remote as the true
  main too. Here the team runs the hub on its own machine, and it can be replaced (below)
  without touching anyone's history.

What it does cost, plainly:

- In normal times the network is a star around the hub: each agent keeps one connection, to
  the hub, and task signals pass through it. A full mesh cost every agent memory for N²
  connections ([DESIGN.md](DESIGN.md) §7). Agents mesh with each other only while
  the hub is down.
- `land --wait-final`, `hs wait-final` and anything that waits for finality wait while the hub
  is down.
- During a network split, only the hub's side settles.
- If the hub's key is lost for good, the repo falls back to waiting for every writer, for good
  (see [Backups](#backups)).

## One hub, not several

You can have more than one hub (`hs add-writer <key> --as <handle> --indexer`, run in the
hub), but each one is another thing finality waits for. A land settles only once **every**
hub has seen it, so if any hub is down, settlement stalls until it's back or removed, and
during a split neither side settles. Keep two only while you replace one, or as a deliberate
standby if losing the hub's key is a real risk. For more availability, add extra seeds or
blind peers instead (above). A blind peer can't be a hub: it has no writer key and can't read
what it stores.

## Replacing a hub

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

## Backups

The hub's data doesn't need a backup: extra seeds, blind peers and teammates have copies of
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

## Many repos on one machine

One process can hub every repo on a machine: see [Hub homes](hub-homes.md).

## Encryption, invites and who can write

- **Repos are encrypted by default.** Every connection between peers is always encrypted. On
  top of that, an encrypted repo's blocks are encrypted at rest, so a blind peer or anyone
  who copies a store sees only ciphertext. `hs init --no-encrypt` (or `hs hubs new
--no-encrypt`) makes a repo whose blocks anyone holding them can read. Use it for a
  public repo, such as one published over git+pear. The choice is made when the repo is
  created and can't change later.
- **The invite is the read key.** It carries the repo key and, for an encrypted repo, the
  encryption key. Anyone who has it can replicate and read the repo, so treat it like a
  password: share it only with the team.
- **Who changes who writes:**
  - An owner adds and removes writers, renames them, and lets a removed one back.
  - A hub admits new writers and hubs (admit folders, hub replacement) and removes other
    hubs.
  - Any writer can leave on its own (`hs remove-writer <its key>`).
  - Every peer enforces this when applying main, so a writer can't change it by running
    a modified hs.
- **Removing a writer stops its writes, not its reads.** Every peer ignores what a removed
  writer writes from then on. It keeps what it already replicated, and while it has the
  invite it can keep reading. Nothing rotates keys yet.
- **Admit folders are write access.** See [Running it](#running-it).

## Versions: hs releases and the repo ABI

Every peer applies main by the same rules, so the rules a repo uses can't depend on which hs
each peer happens to run. A repo has an **ABI**, a number recorded in main (`hs info` shows
it). Every peer judges every change by the repo's ABI, never by its own hs version. A newer
hs in a repo at an older ABI behaves exactly like the older hs.

- **New rules ship switched off.** A release can support a newer ABI, but repos stay where
  they are until an owner runs `hs upgrade-repo`, which moves the repo one ABI at a time.
- **Before upgrading, check the team.** `hs doctor` lists the hs version and newest ABI of
  every connected peer, and says how many peers an upgrade would stop.
- **A peer whose hs is too old stops instead of diverging.** It stops applying main, every
  command says `this repo uses ABI N, newer than this hs supports`, and its writes are
  refused, so nothing it writes is lost. After an update it catches up by itself.
- **Hubs update themselves** (`--updates`, on for a hub-home service). So a hub is usually the
  first peer able to apply a new ABI, and the last one an upgrade would stop.
