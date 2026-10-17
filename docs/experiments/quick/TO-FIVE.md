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
| 1 | **A provisional land that gets undone must say so where I'll see it.** Land exits non-zero or says "NOT on main for anyone else" when the push times out; the feed says `your land #N undone` at once, not at the next sync | q2h-3 a2 | 6 | Partly: `4dceff1` says it plainly at once (q2h-1 a1 saw it and relanded within a minute). Still manual | Yes: when the only overlap is `merge=union` files, `land` syncs and lands again by itself (rerunning `--check`); the a1 to_five |
| 2 | **The change request's named owner gets the lead** | q2s-claims-4 a3 | 3 | Fixed `4dceff1`; confirmed in q2h-1 (a3 led the CR, no race) | Done |
| 3 | **Swarm noise out of my feed and output** (renumbered lines, `/swarm/` changesets) | q2s-claims-4 a3 | 2 | Partly: `quiet` paths in `.hsattributes`; renumbered lines for quiet paths still show | Yes, small |
| 4 | **Land a piece of an item without closing it** | q2s-claims-3 a2 | 1 | Fixed `bf4ee17` (`land --under`) | Done |
| 5 | **Close a parent when its parts are done** | q2s-claims-2 a2 | 1 | Fixed (parts-done feed line plus `claim --done`) | Done |
| 6 | **Link a land to the open part it implements** (touches its paths, or quotes its id) | q2s-claims-3 a3 | 1 | Open | Yes: `land` suggests `--item`/`--under` when the changes fall in an open item's paths |
| 7 | **One step to create and claim a part, or take my part** | q2s-claims-2 a3 | 2 | Open | Yes, small (`item part --claim`) |
| 8 | **`status` never stalls** | q2s-claims-1 a2 | 1 | Reopened by q2h-1 and folded into #12 | See #12 |
| 9 | **Section-aware merge for CONTRACTS.md** | q2-hs-6 a2 | 1 | Open | Maybe: a markdown-sections merge driver; medium |
| 10 | **How long the hub has been gone, on the provisional line** | q2-hs-6 a2 | 1 | Open | Yes, small |
| 11 | **`watch --sync`:** sync when the wait returns | q2s-claims-2 a3 | 1 | Open | Yes, small |
| 12 | **Never hang silently; local commands stay local.** `land`/`sync` say what they fetch and from whom, give up after ~20 s naming the missing piece; `status`/`log` never need the network | q2h-2 a2, a3 (rated 2) | 3 | Fixed `c87ba52`; confirmed in q2h-3 (no stalls, no gap errors, nobody asked for it) | Done | Yes: fetch view gaps online before reading main, bounded, and a clear error when nobody has them |
| 13 | **Teammates' presence and work in progress on a path** (`a2 online, editing /src/scheduler.js, last seen 10 s ago`) in `watch --path` and `claims` | q2h-1 a3 | 1 | Open | Partly: liveness from claims' heartbeats and the signal channel exists; uncommitted edits would need a new signal |
| 14 | **Split a land: unprotected files land, protected ones become a proposal** to the required reviewers in one step | q2h-3 a1, a2, a3 | 4 | Fixed `c8cc9a0` (`land --split`); every agent used it in q2h-4 | Done; follow-ups #16-#18 |
| 15 | **An "approved" line only when the current revision counts it** | q2h-2 a3 | 1 | Fixed: the history line no longer prints a count | Done |
| 16 | **Split by default** when the only blocker is a protected path, and check the policy before running `--check` | q2h-4 a1 | 1 | Fixed `08c009e`: split is the default, decided after the pull and before `--check` | Yes, small: the policy check is local and cheap |
| 17 | **An approval pins my hunks, not the whole file**: a clean merge of teammates' approved sections into the same protected file shouldn't reset it; otherwise re-propose and let `--wait-final` wait | q2h-4 a2 | 1 | Fixed (schema v15): protected files travel inline; approvals bind to the added and removed lines | Yes, medium: approve the proposal's diff against its base, and accept a land whose diff from the merged base is the same |
| 18 | **`land --item C --split`**: land the free files under the item, propose the protected ones, close the item when the proposal lands | q2h-4 a3 | 1 | Fixed `08c009e`: covered paths land under the item, the rest is split off, the item stays open | Yes, small |

## Runs

- **Seed (before `to_five`):** all 4s except q2s-claims-4 a1 (3, ask #1).
- **q2h-1:** 4, 1, 4. a1 (4) asks #1 in its achievable form, a2 (1) asks #12 (the stall that lost it the run), a3 (4) asks #13.
- **q2h-2:** 4, 2, 2. a1 (4) asks #14 and #12; a2 (2) and a3 (2) ask #12 (the overreaching gap check), a3 also #15.
- **q2h-3:** 4, 3, 4. a1 (4) and a3 (4) ask #14 (split protected paths); a2 (3) asks #1 (its outage land vanished silently) and #14.
- **q2h-4:** 4, 4, 4 (3/3 choose). Nobody asks #14 again; a1 asks #16, a2 #17, a3 #18. Every remaining ask is about the approval flow, none about stalls or the outage.
