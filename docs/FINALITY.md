# Finality under a site split: "final" isn't final in `init --hub` repos

Found 2026-10-17 by the q0bs runs (a two-site split, docs/experiments/quick/RUNLOG.md).
**Status: fixed (B + D, below).** The user didn't choose between the options: the standing
instruction was to keep working, and both changes are commits that can be reverted.

## What happens

- Site A has the hub, site B doesn't. Each side lands.
- a3 lands on site A. The hub acks it and a3 is told `#3 final`.
- When the sites meet, site B's lands, made earlier but never seen by the hub, sort **ahead
  of** a3's land:
  - a3's land is renumbered (#2 → #3 in `test/site-finality.js`, with a new hash);
  - in q0bs-min-2, a3's change to the same files was undone and came back as conflicts in
    a3's workspace;
  - a3 had already stopped, so nobody saw it.

## Why

DESIGN.md §11 rests on one assumption: "Autobee linearizes by indexer weight." autobee orders
concurrent nodes by writer weight, then timestamp, then key (`autobee/lib/topo.js` `cmp`).
That assumption no longer holds:

- **Since milestone 7, the owner is light.** `hs init --hub` makes the owner the genesis
  writer with `bootstrapWeight: 1`.
- **The hub can't be heavier than the owner.** autobee caps a grant at the granter's weight
  (`autobee/lib/system.js` `addWriter`: `effective = carrier < weight ? carrier : weight`),
  and a pending promotion needs an approver of weight 2 (`lib/witness.js`), which can't
  exist. The hub's system record reads `weight: 1, maxWeight: 1`, like every agent's.
- **So the hub's ack pins nothing.** A node the hub never saw, with an earlier timestamp,
  sorts in front of what the hub acked. `meta.settled` and `final` are still computed from
  the hub's acks, so they claim a guarantee autobee doesn't give.

## Why nothing caught it

- **The property gate used the old topology.** `test/settle-property.js` built the hub as
  the heavy genesis writer, the pre-M7 topology.
  - It now takes `HS_SETTLE_TOPOLOGY=hub` (a light owner adds the hub, as `init --hub` does).
  - With `hub`, seeds 1, 6 and 8 of 1–8 (40 rounds) reorder settled changesets.
  - With `genesis`, the same seeds have 0 violations.
- **The outage runs had the hub down,** so nothing was falsely settled. Only a partition
  with the hub up on one side shows it.
- **Archived runs:** a scan of every run under `docs/experiments/quick` finds no land that
  was told final and later moved. q2-hs-7's #138 → #140 happened while it was still
  provisional. The archived conclusions stand on their outcomes. q0bs-min-2 is the first
  false final; `duplicate_implementations` reads 1 there because a3's copy was undone, not
  because it wasn't built.

## Options

|     | What                                                                                                                                           | Fixes order                                                                     | Cost                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **Hub as heavy genesis** (before M7)                                                                                                           | yes (gate passes)                                                               | A hub that dies for good can never be removed (a removed genesis keeps its weight, so its unseen ops still sort first); settlement then stalls for good. M7's reason, still true                                                                                                          |
| B   | **Heavy owner grants the hub weight 2, then steps down** (removes itself; its later ops are causally after the removal, so apply ignores them) | yes                                                                             | A carve-out in apply's "heavy bootstrap is never removable" rule, for self-removal only. Owner-only acts (`--human`) move to indexers. A live hub can add a replacement hub at weight 2. If the last hub is lost, settlement falls back to every writer, which is honest at equal weights |
| C   | Heavy owner stays, hub weight 2, owner not a settler                                                                                           | no: an owner land made while the owner can't reach the hub reorders acked lands | rejected                                                                                                                                                                                                                                                                                  |
| D   | **Honest fallback:** when no indexer outweighs the other writers in autobee's system records, settle on every writer's acks                    | yes (it's the gate's control rule)                                              | `final` waits for every agent, so one offline agent stalls it (the q2h stall complaints). The only correct rule for existing light repos, since nothing in them can ever reach weight 2                                                                                                   |

**Done: B for new repos, D for existing ones.**

- **Make the settlement rule match autobee's ordering:** the settlers are the indexers that
  outweigh every other writer in autobee's system records, or every writer when none does.
  That turns D on by itself in existing light repos, and B's weight-2 hub settles alone.
- **Which way a repo goes is visible:** `doctor` names which rule a repo is on and why.
- **The invite and config already carry the bootstrap weight,** so B is a new default, not a
  format change.

**Gates for any fix:**

- `HS_SETTLE_TOPOLOGY=hub` seeds 1–8 have 0 violations;
- `HS_KNOWN_FAILURES=1 brittle-bare test/site-finality.js` passes (seq and hash unchanged);
- q0bs is rerun before the board arm (q0bs-plain-1), which would otherwise measure this bug
  instead of coordination.

## What was done

- **`hs init --hub` (B):**
  - a throwaway genesis writer of weight 2 creates the repo;
  - it grants the hub weight 2 as indexer and names the owner (a plain writer, `owner` in its
    record, who may mark people human);
  - it removes itself, and its key is deleted;
  - the invite carries weight 2 (no `~1`).
    `lib/apply.js` lets a heavy bootstrap remove itself, but only itself and only while an
    indexer of weight 2 remains.
- **Settlement (D):**
  - writer records carry autobee's weight as granted (2 for an indexer granted by a weight-2
    writer, otherwise capped at the granter's), derived for older records;
  - the settlers are the indexers of weight 2, or every writer when there are none
    (`lib/settle.js`, shared by apply and `Repo`);
  - old light repos therefore settle on every writer, and `doctor` says so.
- **Gates:**
  - `test/settle-property.js` runs the `genesis`, `handover` and `hub` topologies by default;
  - the seed 1–8 × 40-round sweeps of `handover` and `hub` have 0 violations (`hub` reordered
    settled changesets on 3 of 8 seeds before);
  - `test/site-finality.js` passes (seq and hash unchanged) and is a regular test now.

## Open

- **Repos created by the new `init --hub` need the new code.** Under the old apply rules, the
  genesis's self-removal is invalid, so the genesis stays a settler that never acks and
  nothing settles. Reverting the code doesn't revert those repos.
- **Repos made between milestone 7 and this fix settle on every writer.** Running feeds ack
  (a feed acks when its own writer is a settler), but the owner rarely runs one: `hs
remove-writer <owner>` (a light owner is removable while the hub remains) takes it out, and
  `doctor` says so. A re-init is the full fix.
- **A hub replacement needs a live hub to grant weight 2,** and the hub's store is locked
  while `seed` runs: in practice, stop the seed, `add-writer --indexer`, restart. A one-step
  `seed --admit-hub` would be the next step if teams hit it.
- **The superseded hint reads `cs.files`,** which keeps only the first paths of a changeset;
  a conflict beyond those falls back to "what landed first".
