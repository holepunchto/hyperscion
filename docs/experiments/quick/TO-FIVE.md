# From 4 to 5: what agents say would make hs a 5

Agents rate `usefulness_vs_git` 4 run after run. Since q2h, each report also answers
`to_five`: the one concrete change that would make it a 5. `analyze.js` appends the raw answers
to `to-five.jsonl`. This ledger groups them, says when each was **last stated**, and judges
whether it is achievable.

**How to use it:**

- **An ask that comes back after it was marked fixed** means the fix didn't land for agents.
  Reopen it.
- **An ask nobody has repeated for three runs** has probably been closed by something else.
- **"Not in hs"** asks (the task, the model, git habits) are recorded so they stop being
  re-read as product gaps.

Seeded from the "most wanted" bullets of q2-hs-6 and q2s-claims-1..4 (before `to_five`
existed).

| # | Ask | Last stated | Times | Status | Achievable? |
| - | --- | ----------- | ----- | ------ | ----------- |
| 1 | **A provisional land that gets undone must say so where I'll see it.** Land exits non-zero or says "NOT on main for anyone else" when the push times out; the feed says `your land #N undone` at once, not at the next sync | q2h-6 a3 | 7 | Fixed: `land` re-lands an undo it finds; `sync` (and `watch --sync`) re-lands one found later, with the same message and --check: "#51 re-landed as #N" | Yes: on an undo, `land` (or the next online command) syncs and lands again with the same `--check`, reporting "#51 re-landed as #N"
| 2 | **The change request's named owner gets the lead** | q2s-claims-4 a3 | 3 | Fixed `4dceff1`; confirmed in q2h-1 (a3 led the CR, no race) | Done |
| 3 | **Swarm noise out of my feed and output** (renumbered lines, `/swarm/` changesets) | q2s-claims-4 a3 | 2 | Partly: `quiet` paths in `.hsattributes`; renumbered lines for quiet paths still show | Yes, small |
| 4 | **Land a piece of an item without closing it** | q2s-claims-3 a2 | 1 | Fixed `bf4ee17` (`land --under`) | Done |
| 5 | **Close a parent when its parts are done** | q2s-claims-2 a2 | 1 | Fixed (parts-done feed line plus `claim --done`) | Done |
| 6 | **Link a land to the open part it implements** (touches its paths, or quotes its id) | q2s-claims-3 a3 | 1 | Fixed: a land naming no item links itself (as `under`) to the one open item whose paths it touches, or that you hold a claim on: "linked to C…" | Yes: `land` suggests `--item`/`--under` when the changes fall in an open item's paths |
| 7 | **One step to create and claim a part, or take my part** | q2s-claims-2 a3 | 2 | Open | Yes, small (`item part --claim`) |
| 8 | **`status` never stalls** | q2s-claims-1 a2 | 1 | Reopened by q2h-1 and folded into #12 | See #12 |
| 9 | **Section-aware merge for CONTRACTS.md** | q2-hs-7 a1 | 2 | Open | Maybe: a markdown-sections merge driver; medium |
| 10 | **How long the hub has been gone, on the provisional line** | q2-hs-6 a2 | 1 | Open | Yes, small |
| 11 | **`watch --sync`:** sync when the wait returns | q2h-5 a2 | 2 | Fixed: `watch --path --count 1 --sync` | Yes, small |
| 12 | **Never hang silently; local commands stay local.** `land`/`sync` say what they fetch and from whom, give up after ~20 s naming the missing piece; `status`/`log` never need the network | q2h-2 a2, a3 (rated 2) | 3 | Fixed `c87ba52`; confirmed in q2h-3 (no stalls, no gap errors, nobody asked for it) | Done | Yes: fetch view gaps online before reading main, bounded, and a clear error when nobody has them |
| 13 | **Teammates' presence and work in progress on a path** (`a2 online, editing /src/scheduler.js, last seen 10 s ago`) in `watch --path` and `claims` | q2h-1 a3 | 1 | Open | Partly: liveness from claims' heartbeats and the signal channel exists; uncommitted edits would need a new signal |
| 14 | **Split a land: unprotected files land, protected ones become a proposal** to the required reviewers in one step | q2h-3 a1, a2, a3 | 4 | Fixed `c8cc9a0` (`land --split`); every agent used it in q2h-4 | Done; follow-ups #16-#18 |
| 15 | **An "approved" line only when the current revision counts it** | q2h-2 a3 | 1 | Fixed: the history line no longer prints a count | Done |
| 16 | **Split by default** when the only blocker is a protected path, and check the policy before running `--check` | q2h-4 a1 | 1 | Fixed `08c009e`: split is the default, decided after the pull and before `--check` | Yes, small: the policy check is local and cheap |
| 17 | **An approval pins my hunks, not the whole file**: a clean merge of teammates' approved sections into the same protected file shouldn't reset it; otherwise re-propose and let `--wait-final` wait | q2h-4 a2 | 1 | Fixed (schema v15): protected files travel inline; approvals bind to the added and removed lines | Yes, medium: approve the proposal's diff against its base, and accept a land whose diff from the merged base is the same |
| 18 | **`land --item C --split`**: land the free files under the item, propose the protected ones, close the item when the proposal lands | q2h-4 a3 | 1 | Fixed `08c009e`: covered paths land under the item, the rest is split off, the item stays open | Yes, small |
| 19 | **Block until my last land is final** (`hs wait-final`), with the hub's stall and recovery shown | q2h-5 a1 | 1 | Fixed: `hs wait-final [#n]`; the provisional line points to it | Yes, small: a `wait-final` alias and a mention on the provisional line |
| 20 | **Say why an approval still counts after a merge** (`approval kept: merged lines from #105`) | q2h-5 a3 | 1 | Fixed: land says "approval of P kept for <file>: your lines are the ones approved; teammates' changes merged in (#n)" | Yes, small: land knows when the line check carried it |
| 21 | **`watch --path` returns at once when the file is already in your files** (changed at or before your synced base) | q2h-6 a1 | 1 | Fixed again: own changesets never satisfy a wait; no early return (it could not tell an old version from the awaited one); a timeout names the teammate change you already have | Yes: count only changesets after my synced base that are not mine; "already here" only for a teammate change I synced
| 22 | **An open proposal covers only the protected paths**: other files always land, and the proposal is updated to just the protected ones | q2h-6 a2 | 1 | Fixed: a proposal made for protected files stays out of lands that touch none; extra files land and the protected ones stay with it | Yes, small: attach the proposal only when the land carries protected changes; split otherwise |
| 23 | **Say when a change request gives me no part** (`CR-1: no part for a1`), so an agent with none knows it is done | q2h-7 a1 | 1 | Open | Yes, small: the CR item can name its parts' owners |
| 24 | **Don't silently reset an approved proposal on a split**: land the approved revision first, propose only the new lines | q2h-7 a2 | 1 | Fixed: a split past an approved proposal lands the approved revision first, then proposes only the new lines; a re-proposal of an approved one warns | Yes, small-medium: split the protected change against the approved text |
| 25 | **A failed `--check` names the incoming changesets it read** and shows the end of the output | q2h-7 a3 | 1 | Fixed: a failed --check leads with the lines that say what failed, drops stack frames, and names the teammates' changesets it read | Yes, small |
| 26 | **Warn before `land --item` closes a whole multi-part item** after one piece (suggest `--under`) | q2-hs-7 a3 | 1 | Fixed by #6: auto-linked lands attach as `under`, so a piece never closes the item | Yes, small: the item has open parts or a title wider than the land |
| 27 | **`wait-final` says whether the hub is reachable** while it waits, and returns as soon as it acks | q0bs-min-1 a1, a2 | 2 | Fixed: a progress line every 30 s says whether the hub can be reached and that you can stop waiting | Yes, small |
| 28 | **Bare numbers everywhere** (`hs wait-final 4`): `#4` is a comment in fish | q0bs-min-2 a2 | 1 | Open | Yes, small |
| 29 | **Say how many peers heard a claim, and whether the hub did** (`you lead (hub + 2/2 peers)`) | q0bs-min-2 a3, q0bs-min-3 a3, q0bs-plain-1 a3 | 3 | Partly: a claim heard by nobody says so (q0bp) | Yes, small: the claim's signal knows its connections |
| 30 | **A claim records the paths it will touch** and warns on edits inside someone else's | q0bs-min-2 a1 | 1 | Open (frozen: no flow or run shows the need yet) | Maybe |
| 31 | **Say when my land was superseded,** not only undone, and don't advise re-landing a duplicate | q0bs-min-3 a1, a2; q0bs-plain-1 a1, a2 | 4 | Fixed: a conflicting restore names who landed first and offers `hs restore <paths>` | Yes, small |
| 32 | **An approval that points at a renumbered changeset** (#4 became another land after the heal) | q0bs-min-3 a2 | 1 | Open | Yes: bind reviews to the changeset hash, show the new number |

## Runs

- **Seed (before `to_five`):** all 4s except q2s-claims-4 a1 (3, ask #1).
- **q2h-1:** 4, 1, 4. a1 (4) asks #1 in its achievable form, a2 (1) asks #12 (the stall that lost it the run), a3 (4) asks #13.
- **q2h-2:** 4, 2, 2. a1 (4) asks #14 and #12; a2 (2) and a3 (2) ask #12 (the overreaching gap check), a3 also #15.
- **q2h-3:** 4, 3, 4. a1 (4) and a3 (4) ask #14 (split protected paths); a2 (3) asks #1 (its outage land vanished silently) and #14.
- **q2h-4:** 4, 4, 4 (3/3 choose). Nobody asks #14 again; a1 asks #16, a2 #17, a3 #18. Every remaining ask is about the approval flow, none about stalls or the outage.
- **q2h-5:** 4, 4, 4 (3/3 choose), zero alerts, 1 min lost. a1 asks #19, a2 #11, a3 #20: all small, none about the approval flow working, the outage or stalls.
- **q2h-6:** 4, 4, 4 (3/3 choose). a3 asks #1 again (seventh time), a2 #22, a1 #21. q2h-5's asks (#11, #19, #20) were all fixed, and three new ones appeared: the 4 has held for three runs while the asks keep shrinking.
- **q2h-7:** 4, 4, 4 (3/3 choose), zero alerts. a1 #23, a2 #24, a3 #25: all small and new. Four runs at 4,4,4 (q2h-4..7) with every earlier ask fixed: the asks keep coming, smaller each time, and the rating doesn't move. Read as the agents' ceiling for this task, not a product gap.
- **q2-hs-7 (full q2):** 4, 4, 4 (3/3 choose). a1 #9, a2 #21 (reopened: my fix regressed the wait), a3 #26.
- **q0bs-min-1/2 (two-site split):** 4,4,4 both. Asks #27 (hub reachability in waits), #28, #29, #30.
- **q0bs round 2 (fixed core):** claims 3,3,4, board 3,3,4. Every 3 is about the heal: #31 (superseded, not undone) from both arms, #32. Not a claims or board gap: no mechanism coordinates sites that can't hear each other.
