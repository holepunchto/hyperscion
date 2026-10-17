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
| 1 | **A provisional land that gets undone must say so where I'll see it.** Land exits non-zero or says "NOT on main for anyone else" when the push times out; the feed says `your land #N undone` at once, not at the next sync | q2h-1 a1 | 5 | Partly: `4dceff1` says it plainly at once (q2h-1 a1 saw it and relanded within a minute). Still manual | Yes: when the only overlap is `merge=union` files, `land` syncs and lands again by itself (rerunning `--check`); the a1 to_five |
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
| 12 | **Never hang silently; local commands stay local.** `land`/`sync` say what they fetch and from whom, give up after ~20 s naming the missing piece; `status`/`log` never need the network | q2h-1 a2 (rated 1) | 1 | Fixed, not yet confirmed in a run: missing view blocks are fetched before a command reads main, or it fails with one clear line; the board loads after joining; settle is bounded (RUNLOG q2h-1) | Yes: fetch view gaps online before reading main, bounded, and a clear error when nobody has them |
| 13 | **Teammates' presence and work in progress on a path** (`a2 online, editing /src/scheduler.js, last seen 10 s ago`) in `watch --path` and `claims` | q2h-1 a3 | 1 | Open | Partly: liveness from claims' heartbeats and the signal channel exists; uncommitted edits would need a new signal |

## Runs

- **Seed (before `to_five`):** all 4s except q2s-claims-4 a1 (3, ask #1).
- **q2h-1:** 4, 1, 4. a1 (4) asks #1 in its achievable form, a2 (1) asks #12 (the stall that lost it the run), a3 (4) asks #13.
