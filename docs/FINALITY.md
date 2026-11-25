# Finality: provisional, settled, final

Every land goes through three states:

| state           | means                                                     | what can still happen                               |
| --------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **provisional** | on main, but the repo's settlers haven't all seen it      | a concurrent land can move or undo it (you're told) |
| **settled**     | every settler has acked it; its place in history is fixed | nothing reorders it; a Show may still get "changes" |
| **final**       | settled, and accepted by review                           | nothing                                             |

"Accepted by review" depends on the kind of change: a Ship is final once settled, a Show once
a requested reviewer approves, and an Ask was approved before it landed
([AGENTS.md](AGENTS.md)).

## Who settles

A repo's **settlers** are its hubs: the indexers `hs init --hub` or `hs hubs new` made, and
any added with `hs add-writer --indexer`. With one hub (the normal case), a land is settled the
moment the hub has seen it, usually within a second or two.

A repo with no hub settles on **every writer's** ack instead: a solo `hs init` repo, or a team
repo whose last hub was removed. Then one offline writer holds up settlement for everyone,
which is why team repos have a hub ([The hub](hub.md)).

`hs doctor` says which rule a repo is on, how far main is settled, and what each settler has
seen.

## What the guarantee rests on

Main is a multiwriter log. When two lands are concurrent (neither writer had seen the other's),
every peer orders them the same way: by writer weight, then time, then key. An ack can only fix
the order if it comes from a writer that outweighs every writer whose concurrent lands it
might not have seen yet. So a hub has weight 2 and every other writer weight 1: once the hub
has acked a land, no land it hadn't seen, from anyone, can sort in front of it.

Two consequences:

- **Only a live hub can make another hub,** since a grant is capped at the granter's weight. To
  replace one, add the next hub before the old one goes ([Replacing a hub](hub.md#replacing-a-hub)).
- **If the last hub is lost,** nothing can grant weight 2 again, and the repo settles on every
  writer from then on. It keeps working; finality just waits for everyone.

## During an outage or a split

- **Hub down:** lands are still accepted, shared and checked by every peer, but stay
  provisional. They settle by themselves once the hub is back.
- **Network split:** only the side with the hub settles. The other side keeps landing
  provisionally. When the sides meet, its lands sort after everything the hub had settled, so a
  settled land never moves. A provisional land can be renumbered (`your land #11 is now #14`)
  or, if it touched the same files as a settled one, undone. hs says so loudly, keeps your
  changes, and `hs sync` lands them again.

## Waiting for it

- `hs land` waits up to 10 s for the hub and ends with `#27 final`,
  `#27 settled; not final until review from a4`, or `#27 provisional: waiting for hub to ack`.
- `hs land --wait-final` and `hs wait-final [n]` wait until final (exit 2 on timeout).
- `hs log` tags every changeset `[final]`, `[settled]` or `[provisional]`; `hs status` lists
  your lands that aren't final yet.
- You don't need to wait to carry on. Build on a teammate's land once it's settled if you want
  to be sure it won't move.
