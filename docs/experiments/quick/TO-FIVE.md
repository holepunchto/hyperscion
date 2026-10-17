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
| 1 | **A provisional land that gets undone must say so where I'll see it.** Land exits non-zero or says "NOT on main for anyone else" when the push times out; the feed says `your land #N undone` at once, not at the next sync | q2s-claims-4 a1, a2 | 4 | Partly: `4dceff1` says an undone land plainly, on the flip check. No immediate feed line | Yes: a `--for-me` reorg line for your own land, and a non-zero exit on a push timeout |
| 2 | **The change request's named owner gets the lead** | q2s-claims-4 a3 | 3 | Fixed `4dceff1` (`--lead`: the named lead ranks first once they claim). q2h checks it | Done if q2h shows no race for the CR |
| 3 | **Swarm noise out of my feed and output** (renumbered lines, `/swarm/` changesets) | q2s-claims-4 a3 | 2 | Partly: `quiet` paths in `.hsattributes`; renumbered lines for quiet paths still show | Yes, small |
| 4 | **Land a piece of an item without closing it** | q2s-claims-3 a2 | 1 | Fixed `bf4ee17` (`land --under`) | Done |
| 5 | **Close a parent when its parts are done** | q2s-claims-2 a2 | 1 | Fixed (parts-done feed line plus `claim --done`) | Done |
| 6 | **Link a land to the open part it implements** (touches its paths, or quotes its id) | q2s-claims-3 a3 | 1 | Open | Yes: `land` suggests `--item`/`--under` when the changes fall in an open item's paths |
| 7 | **One step to create and claim a part, or take my part** | q2s-claims-2 a3 | 2 | Open | Yes, small (`item part --claim`) |
| 8 | **`status` never stalls** | q2s-claims-1 a2 | 1 | Fixed (bounded view fetch; busy message) | Done |
| 9 | **Section-aware merge for CONTRACTS.md** | q2-hs-6 a2 | 1 | Open | Maybe: a markdown-sections merge driver; medium |
| 10 | **How long the hub has been gone, on the provisional line** | q2-hs-6 a2 | 1 | Open | Yes, small |
| 11 | **`watch --sync`:** sync when the wait returns | q2s-claims-2 a3 | 1 | Open | Yes, small |

## Runs

- **Seed (before `to_five`):** all 4s except q2s-claims-4 a1 (3, ask #1).
