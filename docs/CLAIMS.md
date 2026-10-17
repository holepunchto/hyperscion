# Claims: saying what you're about to do (proposal, milestone 8)

Status: **proposal**, nothing built. It supersedes the brainstorm in DESIGN.md §14 and keeps
its data and its stance (never block, topic first, a TTL, concurrent claims are all kept).

## Why

Duplicated work is now the biggest waste we measure. Every q1, q2 and q2s run had 2–4 agents
build the change request's flight-minutes code in parallel; q2-hs-6, otherwise clean, still
scored `duplicate_implementations: 3`. "Let me claim this first" is the most-wanted feature,
and agents asked for `hs claim CR-1`.

What the runs say about the problem (DESIGN.md §14):

- **The duplication is about a topic, not a file:** three agents, three files, one change
  request. Path locks would catch none of it.
- **It's a race at time zero:** everyone reads the change request within the same few seconds.
- **Telling agents to coordinate in prose doesn't work:** a NOTES.md "I'll handle it" line was
  ignored, and NOTES.md is itself the most merged file in every run.

What this design has to deliver:

- **Speed:** a claim reaches every teammate in well under a second, including the agent that is
  about to start the same thing.
- **Nearly zero conflicts:** claims never go through a file that has to be merged.
- **Never block an agent:** a claim is information, never permission.
- **Humans in the loop without drowning them:** some work needs a person's yes. In a busy
  multi-agent system per-action approvals don't scale, so the design has to make approvals
  rare, coarse and batched.

## The idea in one paragraph

Work is an **item** (a change request, a suggestion, a part of either). Agents **claim**
items. A claim travels twice:

- **as a signal:** signed and gossiped over the swarm connections we already have (hub,
  feeds, the outage mesh), so teammates see it in milliseconds;
- **as a record:** an op in main, so a teammate who wasn't online, or who clones tomorrow,
  still sees it.

Signals carry presence (who is actively on it, right now). Records carry history (who claimed,
released, finished; who approved). Who leads an item is computed from the claims' own signed
content, so the fast view and the durable view always agree. Lands and proposals that
reference an item close it, and review ops approve it when policy asks for a human.

## Items

An item is the anchor. A claim says "I'm on item C7", not "I'm working on flight minutes";
free text is how an item is described, not how it's matched.

- **Where items come from:**
  - **A change request is an item** from the moment it lands: pm's `CHANGE-REQUEST.md` becomes
    `hs item new --from CHANGE-REQUEST.md`, or the land flag `--item`.
  - **Anyone can suggest one:** `hs suggest "cache the distance matrix" [--paths p] [--kind k]`
    (an idea, a follow-up, a bug). That's the "idea suggestion" flow.
  - **Parts:** `hs item part C7 "flight minutes per stop (scheduler)"`. Splitting a change
    request is how a lead hands out work, and a part is just another item with a parent.
- **Lifecycle:** suggested → (approved, if policy asks) → open → claimed → done | dropped.
  - An open item is just an item with no claimant.
  - **Done** is a land or proposal that references it: `hs land --item C7`, or `C7` in the
    message. The item closes as soon as that land is _accepted_ (provisional), not when it
    is final. Final needs the hub, and an item left open through a stall would show "a2 is
    still on it" for the length of any outage. If the land later flips (DESIGN.md §11), the
    item reopens, using the same detection that restores a flipped land.
- **Ids are content hashes:** the hash of the creator's key, the time and the title, shown
  short (`C7f3`) as changesets' and proposals' hashes already are. A part hashes its parent
  and its title. An item can then be named, signalled and claimed before its record is
  ordered, which matters most with the hub down: a counter from `apply` couldn't be named
  until the item op settles.
- **Fields:** `id`, `title`, `parent`, `kind`
  (`implement`, `fix`, `contract`, `refactor`, `idea`), optional `paths`, `author`, `from`
  (a file or changeset it came from), and `needs` (approvals, from policy).

Matching by text survives only as a hint. When an agent claims a fresh item whose title looks
like an existing one (shared words, shared paths), `hs claim` says so, but never decides.

### Learned in the first gate runs (q2s-claims-1, -2)

- **A suggested lead:** a change request that says "a3 leads" made agents argue with hs when
  a2 claimed first (q2s-claims-2, -4). `hs item new --lead a3` names one: the first claim leads
  until a3 claims, then a3 does.

- **Parts are the lead's to hand out.** In the first run two agents split their own parts
  off an unclaimed change request, and a third then claimed it and built the same thing. Now:
  - `hs item part` works only for the item's lead, a co-lead or its author;
  - the lead's verdict lists the parts and who holds them;
  - a non-lead is told "don't build it too" and pointed at the lead.

  In the second run the duplicates went from 3 to 1 implementation plus a fallback.

- **Sharing works both ways:** a claimant who names the lead with `--with` is a co-lead, as
  is one the lead names.
- **Closing a parent:** when the last part lands, the feed says so (`parts-done`). The parent
  may still have work of its own, so it doesn't close by itself: its lead runs
  `hs claim <id> --done`, which the item's author or a claimant may record.

## Two layers

|           | signal                                                                | record                                            |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| transport | `hs/signal` protomux channel on every replication connection          | autobee op in main                                |
| speed     | ms over the star (agent → hub → everyone); the outage mesh relays too | an append, then ordering and settlement           |
| holds     | live claims, heartbeats, "working on part X"                          | items, claim / release / done / take, approvals   |
| answers   | who is on it right now? who leads?                                    | what was claimed, by whom, when, and how it ended |
| lost if   | everyone who heard it goes offline (fine: records cover it)           | never (it's history)                              |
| conflicts | none: never merged                                                    | none: keyed per (item, writer), no files          |

### The signal

- **Transport:** corestore replicates over `Protomux.from(noiseStream)`, a muxer shared per
  connection, so `lib/net.js` opens one more channel (`hs/signal`, keyed by the repo's
  discovery key) on every connection it already has.
  - **No new connections and no new topics.**
  - **The fallback:** a hypercore extension on the bootstrap core, if the channel proves
    awkward.
- **Messages:** `claim`, `heartbeat`, `release`, `done`, `take` and `part` are each one small,
  signed message: `{ item, action, writer, time, ttl, note, sig }`.
  - **The signature** is made with the writer's local core key pair, which is writable, so
    the secret key is there.
  - **Checking it:** the signer's public key must belong to an admitted writer, checked
    against main's writer records as `apply` already does for handles. Anything else is
    dropped.
- **Relays:** the hub and every feed relay what they haven't seen (dedupe by message hash, a
  hop limit). Commands send and listen but don't relay. That's the star in normal times and
  the feed mesh during an outage, the same shape as replication.
- **Snapshot on connect:** when the channel opens, each side sends its current live set. A
  short-lived command (`hs claim`, `hs status`) therefore sees the whole live board within
  one round trip, without having been online before.
- **Presence and TTL:** a claim lives for its TTL (default 20 min).
  - **Renewal:** the claimant's feed renews it every minute while it runs, and any `land`,
    `sync` or `claim` by the claimant renews it too.
  - **No feed:** an agent without a feed (pm in q2) goes stale on the TTL alone.
  - **Stale is visible, not silent:** `C7: a2, stale 6 min — hs claim take C7`.

### The record

- **The op:** one new type, `OP_ITEM`, with actions `new`, `part`, `claim`, `release`,
  `take`, `done` and `drop`. The signed signal payload goes in it verbatim, so the record
  _is_ the signal.
- **When it's written:** at every state change (claim, release, take, done, drop), plus item
  creation. Heartbeats never go to history.
- **Storage:** `apply` keeps `hs-item/<id>` and `hs-claim/<id>/<writer>`, appends a
  `hs-ev` event so `hs watch` and `--for-me` show it, and indexes `paths` for the land note.
- **Offline:** a claim made with the hub down is a provisional op, like any land. Its signal
  has already reached whoever was reachable.

## Who leads

A **lead** is computed from content, never from autobee's order: the earliest signed `time`
among valid claims on the item, then the smaller writer key.

- **What's guaranteed:** the rule depends only on the claims' content and the item's. So a lead
  can only be displaced by a claim with an earlier signed time, or by the lead the item names
  (`hs item new --lead a3`) claiming it. Never by a reorg or by the order in which claims arrive.
  which claims arrive.
  - **The signal view can be incomplete:** at 1.5 s it may not have heard every claim, so
    its verdict is provisional. `hs claims` always shows the current lead.
  - **The record view is complete eventually:** a straggler reading records sees every
    claim and computes the same lead the signal view converges on.
- **The race at time zero:** `hs claim` waits about 1.5 s after sending, collecting
  competing signals, and then says:
  - `you lead C7` or
  - `a2 leads C7 (claimed 0.4 s before you)`, followed by what to do instead: the open parts
    of C7, review a2's work when it lands (`hs watch --path`), or claim with `--with a2` to
    share it. Shared claimants are co-leads, and the item shows both.
- **Never a lock:** the second claimant may still work on it. The verdict is advice, and the
  margin is shown, so agents and humans can judge.
- **Clock skew:** times come from each writer's clock, so a writer with a fast clock "loses"
  races and one with a slow clock "wins". Within a team that's harmless. Bounding it, by
  rejecting claims timed more than a few seconds ahead of the receiver's clock, is an open
  question.

## Never blocking, and what does block

- **Nothing about claims blocks anyone:** no command refuses to run because of a claim.
- **The notes:**
  - **When you land into paths someone else's live claim lists:**
    `note: /src/pricing.js is in a3's claim C7 (2 min, active)`.
  - **When `sync` brings in a land closing an item you hold:**
    `C7 done by a3 (#82); your claim is closed`.
- **The only things that refuse a land are the ones that do today:** `/.hsreview` rules and
  conflicts. Phase 2 lets an approved claim _satisfy_ `/.hsreview`. That relaxes a block; it
  never adds one.
- **Over-claiming:** at most 3 live claims per writer by default. A fourth is refused by the
  CLI, not by `apply` ("release one first"), so the board stays meaningful. The limit is
  soft: a straggler's record view can still show more for one writer (claims made offline,
  say), and that's harmless.

## Why this has nearly zero conflicts

NOTES.md conflicts because everyone edits the same file. Claims never touch a file:

- **Signals are never merged:** each is an independent signed message, deduplicated by hash.
- **Records carry no path entries:** they are keyed per (item, writer), so `apply`'s per-path
  checks never see two of them collide.
- **Concurrent claims aren't conflicts:** they are both kept, ordered, and resolved into a
  lead by the content rule.

The only "conflict" left is the human one, two agents wanting the same item, and that's the
point: it surfaces in a second instead of after three implementations.

## Humans in the loop

**Who counts as a human:** a writer whose record says `human: true`
(`hs add-writer <key> --as ryan --human`). Only the team owner can set it, as with
`--indexer`. Policy can then name `@humans`, or particular handles.

**When an approval is needed:** policy says so, never the agent. `/.hsreview` grows item
rules next to its path rules:

```
# /.hsreview
/src/billing/**          approvals=1 reviewers=@humans
item kind=contract       approvals=1 reviewers=@humans
item kind=idea           approvals=1 reviewers=ryan
```

**What an approval is:** a review op with a new target, `TARGET_ITEM`. Approvals stay
signatures (DESIGN.md §10), so a quorum is still `apply` counting distinct writers, and
`approve`, `changes` and `comment` all work on items as they do on proposals.

- **A suggestion that needs approval:** it is claimable at once (as built: see below); only
  lands into protected paths wait for the approval.
- **A claim that needs approval:** the agent can start at once (never blocked), but its land
  into protected paths still waits, exactly as an unapproved proposal does today.

**Keeping the load bearable** (the "nightmare" in a busy system):

1. **Approve the plan, not each diff (phase 2):** an approved claim with `paths` satisfies
   `/.hsreview` for lands on those paths by that claimant until the item is done. One "yes"
   up front replaces a review per land. This changes `apply` enforcement, so grant scope (paths
   ⊆ the claim's), expiry (the item's TTL and done) and who may grant (`reviewers=` of the
   rule) need the same care `.hsreview` got.
2. **Standing grants:** `hs grant a3 kind=implement paths=/src/pricing/** for 7d` records "a3
   may claim this kind of work without asking". The human writes policy once; matching claims
   go straight through.
3. **Escalation only by policy:** agents don't decide what needs a human; `/.hsreview` does.
   Everything else flows without one.
4. **Batching:** `hs inbox` (and `watch --for-me` for humans) lists what waits, grouped by item
   and kind, with `approve` and `changes` accepting several targets at once.

The weak spot is that humans don't sit in `hs watch`. For now `hs inbox` and `--for-me` are
the surface, and a Keet bridge (posting approval requests to a team room and taking the answer
back as a review op) is the natural next step.

### What phase 2 built (steps 1-3)

The sketch above, with these choices made while building it:

- **Gated items are claimable at once.** Nothing waits on a person except a land into the
  paths a rule protects. An agent can claim, build and test while the approval is on its way.
- **The requirement is pinned when the item is created** (`needs`, `reviewers`). Creating an
  item that nobody could approve is refused, with the fix (`hs add-writer <key> --human`).
- **An approval pins the item's hash** (id, title, kind, paths and suggested lead), so a
  person approves exactly what they saw. The author's own approval never counts.
- **Who rides an approved plan:** the item's author or its named lead, and only for paths the
  item names. A claimant can't ride someone else's approval.
- **Approvals can arrive before their item** (signals travel first): they are kept and count
  when the item arrives.
- **A policy edit that raises `approvals` after an item was approved** makes it stop covering
  lands. That is the safe direction, and a second approval restores it.
- **The commands:**

```sh
hs add-writer <key> --as ann --human          # team owner only
hs suggest "cache the distance matrix"        # an item of kind idea
hs inbox [--json] [--approve-all]             # items you can approve, then proposals naming you
hs review C1a2b3c approve|changes|comment     # an item review
hs land --item C1a2b3c                        # closes it; protected paths ride its approval
hs land --under C1a2b3c                       # a piece of it; the item stays open
```

- **The feed and `hs claims`:** `hs claims` prints `needs 1 approval (0/1, from ann)` on a
  gated item. The feed has `item-request` (for its reviewers), `item-review` and
  `item-approved` (for the item's author and lead).

## Commands (sketch)

```sh
hs item new "CR-1: price per flight minute" --from CHANGE-REQUEST.md   # pm, or --item on land
hs item part C7 "flight minutes per stop (scheduler)"
hs suggest "cache the distance matrix" --paths src/geo.js --kind idea
hs claim C7.2 [--with a2] [--note "doing the scheduler side"]          # waits ~1.5 s, prints the lead
hs claims                                                               # the live board
hs claim done|release|take C7.2
hs land --item C7.2 -m "..."                                            # closes on final
hs review C7 approve        # humans, or reviewers named by policy
hs inbox                    # what waits for you (humans)
```

**Where claims show up:**

- **Feed:** `{"type":"claim","item":"C7","by":"a2","lead":true,...}` and `{"type":"stale",...}`.
- **`status`:** your claims, and live claims near your edits.
- **`sync` and `land`:** the notes above.
- **`AGENTS.md`:** one rule, "before you start something new, `hs claim` it; if someone
  leads, take a part or review".

## Fit with what exists

| need                       | reuse                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| fast transport             | the replication connections and protomux muxer (`lib/net.js`)                     |
| relay and outage behaviour | hub and feed roles, the fallback mesh                                             |
| identity, signatures       | writer keys, writer records, handles                                              |
| history, feed, `--for-me`  | a new op beside propose and review; the `hs-ev` event log                         |
| approvals                  | the review op with a new target; `/.hsreview` with `item` rules                   |
| path-scoped defaults       | `/.hsattributes` (like `-check` and `quiet`), e.g. `src/billing/** kind=contract` |
| closing                    | lands and proposals referencing an item                                           |

## Alternatives considered

- **NOTES.md by convention:** the cheapest option, and the one §14 suggested measuring first.
  Rejected for the reasons given above: it is a hot merge file, it is prose nobody is made to
  read, and agents ignored "I'll handle it" lines in S2. (It remains the baseline to beat.)
- **Records only (an op, no signal):** simpler, and ops already replicate in milliseconds
  when the hub is up. But heartbeats would bloat history, a command would need to have been
  online to know the live board, and presence ("is a2 still on it?") has no natural home.
  The signal layer is small; it's the snapshot-on-connect that makes `hs claim` instant.
- **Signals only (no record):** fast, but stragglers, late clones and humans reading
  tomorrow see nothing, and closing items needs history.
- **Locks:** svn-style blocking. It solves a problem we barely have (same-file work merges
  fine) and slows the parallel work that goes well.
- **Leave it to chat (the Keet MCP):** good for discussion, but it isn't tied to lands, can't
  close items, and isn't there for swarms without Keet. The bridge goes the other way: hs
  items posted to a room.

## Phases and the gate

**Phase 1, measurable on its own:**

- the signal channel, with signing, relays and snapshot-on-connect;
- `OP_ITEM` with `new`, `part`, `claim`, `release`, `take` and `done`;
- the CLI: `hs claim`, `claims`, and `item new`/`part`;
- the lead verdict with its settling window;
- the TTL and heartbeats from feeds;
- the feed line, the land note, closing on `land --item`;
- the 3-claim limit;
- the scenario change: the injector creates the change request as an item. The brief still
  says only that a change request appears, so the one thing the gate changes is that it is
  claimable.

**Gate:**

- **The run:** q2s and then q2 with claims, compared with q2s-hs-3 and q2-hs-6.
- **Success:** `duplicate_implementations` goes from 3 to 1 with no rise in time to
  acceptance, calls per land or minutes lost.
- **If it doesn't beat that**, it doesn't ship: the finding goes in the docs instead.

**Phase 2, the human layer:**

- `human` writers;
- `item` rules in `/.hsreview` and `TARGET_ITEM` reviews;
- `hs suggest` with approval;
- `hs inbox` with batched approvals;
- standing grants;
- "approve the plan" (an approved claim satisfies `/.hsreview` on its paths).

**Gate:** a scenario with a human-gated item (a contract change that needs `@humans`), with
a scripted human approving from `hs inbox`. It measures approvals needed per land and the
time agents waited on them.

## Open questions

- **Verifying signatures:** the writer key is the local core's key, derived from a
  manifest, so a signal carries the signer's public key and the receiver checks it against
  that core's manifest. Confirm against autobee's writer setup before building.
- **Clock skew bounds** for the lead rule (see above).
- **Relay fan-out at swarm scale:** 20 swarm writers that never claim still receive every
  signal, which is cheap but non-zero. Should feeds of `quiet` writers opt out?
- **Parts by whom:** only the item's lead, anyone, or whoever made the item? Probably anyone,
  with the lead's parts shown first.
