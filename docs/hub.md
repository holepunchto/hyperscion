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
  They store the repo encrypted and can't read it.
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
it has to be one both can reach (the same machine, or a shared folder). Otherwise stop
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

  [FINALITY.md](FINALITY.md) shows what goes wrong when this is fudged.

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
