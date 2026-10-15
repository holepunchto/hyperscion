# a3b report (took over the scheduler from a3)

## 1. What I built
a3 had already landed a complete greedy scheduler (#11, #17) with the Plan shape pinned in CONTRACTS.md and 15 unit tests; nothing unlanded was recoverable (no open proposals from a3). I:
- #20: NOTES line announcing the takeover (a3b answers for a3).
- #24: trip bundling. A trip may now leave the depot up to 30 min later so that a later stop meets its window. Drones still never hover, and an express stop is never delayed. Also made the express check consistent (`isExpress`). On day1 this cut 13 trips to 12 (p07+p02 on one d4 trip), still 18/19 delivered. Added 2 tests and updated the CONTRACTS rules line.
- #26: CONTRACTS lists the `invalid delivery window` reason (raw day files only), plus a test.
- Checked: all 3 fixtures give sensible plans. A 1000-package synthetic day plans in about 0.36 s. edge-crowded's 6/12 looks close to the best possible (3 trips of about 12 min in a 45 min day).
Final state: main #26, 69 tests green, `node src/cli.js plan fixtures/day1.json` prints 18/19 in 12 trips, €101.64.

## 2. How I learned about teammates' work
- One `hs sync` at the start brought in #2–#19 with one-line messages. That plus `hs log -n 40` and NOTES.md was enough to rebuild a3's context in about 2 minutes. This was the most valuable part for a handover.
- Background `hs watch --json >> .hs/feed.jsonl`, read with `tail`. It caught lands, settlements, a4's Show request on #23, a5's approval, P1 being proposed, reviews and approvals. My feed did not go silent; a5 reported in NOTES that theirs did during the earlier hub outage.
- `hs watch --path ... --count 1 --timeout N` to wait. Twice it timed out (300 s, 280 s) with 0 matches: the team had gone quiet.
- `hs proposals` / `hs show P1` to read a4's proposal.
Yes, the feed replaced polling. I never ran a sync just to look.

## 3. Moments where others' work changed what I did
- a3's #17 and a2's #14/#18 notes (rounded-up delayed starts, geo cross-checks with a strict window[0] check) told me the invariants teammates check against my output. I kept the bundling shift rounded up with `ceil2`, so a2's strict cross-check still passed on the first try.
- NOTES from a4/a1 (#21/#22: the report reads `trip.end`, no alias needed) meant I left the Plan shape alone.
- The reverse direction: my #24 moved p18/p02 to other drones, which changed their prices. Prices were then per delivering drone's home depot (day1 p18 €7.52 → €9.53). That led a4 to open P1 (price km from the nearest depot). I commented on P1 in support.

## 4. Conflicts, rebases, flips
- #24: `main moved to #23 while checking; checking again`, then the check passed and it landed. This was a re-check, not a rebase: only NOTES.md overlapped, and it uses union merge. I counted it as 0 auto-rebases.
- #26 brought in #25 cleanly.
- 0 real conflicts, 0 undone lands, 0 reorgs seen. All 3 of my lands said `#n final` within seconds.
- Hub outage: it happened before I joined (a4's #21 says "re-land after hub outage"). I had no stalls.

## 5. Friction, bugs, confusing output
- **`hs show P1` diffs against current main, not the proposal's base.** P1 was based on #24. Shown at main #26, its diff appeared to delete lines it never touched: my #26 CONTRACTS line
  `-  (and \`invalid delivery window\` for a raw day file with \`earliest > latest\`; \`loadDay\` rejects those).`
  and a5's #25 NOTES line `-- [a5] @a4 approved #23 ...`. The header does say `based on main #24`. a5 independently hit the same confusion (their approval comment mentions it). I could not check whether landing P1 keeps those lines: P1 was approved but not landed when I stopped.
- `hs watch --path /NOTES.md --path /src --path /test --count 1` did not fire when P1 was proposed, even though P1 touches NOTES.md and src/pricing.js. Proposals aren't changesets, so this is by design, but it meant I learned about P1 from the full feed, not my targeted wait.
- a5 reported (NOTES) that `hs watch --json` silently stopped after #19 during the hub outage and never resumed. I didn't see this myself, but a feed that dies without an error line is dangerous when it replaces polling.
- Mine, not hs's: `hs proposals` run from the wrong cwd gave `not a hyperscion worktree` with a full stack trace. The message is correct, but the stack trace is noise.

## 6. Compared with git
Better than a shared git repo here:
- Lands are lock-free and per file. With 5 agents all appending to NOTES.md, git would have produced push rejects and pull/rebase cycles on nearly every push. Here `land --check` re-checked on the moved main and landed without my involvement.
- Union merge for NOTES.md is set up by default (possible in git with `.gitattributes merge=union`, but rarely done).
- The push-style feed and `watch --path --count 1` replaced `git fetch && git log` polling.
- `--check` runs tests on main plus my change; with git you'd need CI or a merge queue for that.
- Takeover was easy: sync, log, NOTES, `.hsowners` already listing `a3 a3b`. In git, a3's unpushed branch would be just as lost, so no difference there.

Worse than git, or no better:
- The proposal diff rendering above. `git diff base...branch` gets this right.
- Review/proposals are hs-specific. In git you'd use GitHub PRs, which are more mature.
- For my part of this run (no conflicts, 3 small lands), plain git with frequent pulls would have worked nearly as well. The gains are mostly ergonomic and grow with land frequency.

## 7. Features I wanted
- `hs show P<n>` that diffs against the proposal's base, or a "preview the land" 3-way result against current main.
- An option for `watch --path` to also match proposals and reviews touching that path.
- A heartbeat or error line in `watch --json` when the connection to the hub drops (see a5's silent feed).
- A way to `@`-mention an owner in a proposal or review so a successor (a3b for a3) gets pinged automatically. Without it I had to take over by hand-written NOTES lines.

## 8. JSON
```json
{
  "agent": "a3b",
  "usefulness_vs_git": 4,
  "would_choose_hs_over_git_for_this": true,
  "lands_attempted": 3,
  "auto_rebases": 0,
  "real_conflicts": 0,
  "flips_seen": 0,
  "stalls_or_unavailable": 0,
  "used_watch_feed": true,
  "times_others_work_changed_my_plan": 2,
  "proposals_made": 0,
  "reviews_given": 1,
  "review_usefulness": 3,
  "output_clarity": 4,
  "knew_when_my_land_was_safe": 5,
  "confusing_messages": 1,
  "minutes_lost_to_hs": 3,
  "biggest_win": "One sync + log + NOTES rebuilt a dead teammate's full context in minutes; --check lands re-checked on a moving main without my intervention and reported 'final' within seconds.",
  "biggest_friction": "hs show P1 diffs a proposal against current main instead of its base, so it appears to delete lines landed after it (my #26 CONTRACTS line, a5's NOTES line).",
  "most_wanted_feature": "Proposal diff against its base (or a preview of the 3-way land result), and watch --path matching proposals."
}
```
