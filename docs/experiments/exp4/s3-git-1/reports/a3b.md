# a3b report (took over the scheduler from a3, git arm)

## 1. What I built

When I arrived, a3 had already landed nearly all of the scheduler on main: the greedy `plan(day)`, the pinned Plan shape in CONTRACTS.md, the geo integration, the hover cap and 15 tests. There were no `ask/` branches on origin (`git branch -a` showed only `origin/main`), so there was no unlanded a3 work I could find. Anything a3 had not pushed was simply gone, and git gave no sign that any such work had existed. My work on top of that:

- be3bdde: a NOTES.md line saying I took over the scheduler and answer for a3.
- 411fd8a: scheduler tests. I ran 80 seeded random days (1–4 mixed drones, two depots, windows, express, short days) through a3's independent `checkInvariants` checker. The tests also cover determinism, a deep-frozen input (no mutation), stable reason keywords, `plan(loadDay(x))` matching `plan(x)` on 30 random days, the empty day, a day with no drones, a raw day without `dayLengthMinutes` (default 600), and `TypeError` on bad input. Before that I ran an ad-hoc performance probe: 400 packages plan in about 60 ms.
- eba749e: trips with 3+ stops are now re-ordered with a2's `geo.orderRoute` (NN+2-opt). The new order is kept only when it is still feasible, shorter, does not start later and does not hover more. I updated the CONTRACTS algorithm line and added a NOTES line. This acts on a2's earlier NOTES suggestion to a3.

The final state on main (5e820f4) is 77/77 tests passing. `node src/cli.js plan fixtures/day1.json` delivers 18 of 19 packages; the 19th (p19, 11.5 kg) is listed as unassigned, "too heavy".

## 2. How I learned about teammates' work

- The first `git pull` plus `git log --stat -20` and reading NOTES.md/CONTRACTS.md gave me nearly all the context. I reconstructed a3's history from the commit messages d5d9f26 → 9508642 → a0cf71a → 558718d → 418c052.
- I ran `git branch -a` and `git ls-remote origin` to look for unlanded a3 work. I found none.
- After each push I ran the playbook's bounded loop (`fetch -q; log HEAD..origin/main`, sleep 20, up to 15 tries), then `git log --stat HEAD..origin/main`, `git show <sha> --stat`, and `git diff HEAD origin/main -- NOTES.md` to read only the new notes.
- I polled about 3 times, roughly 9–10 minutes of wall-clock waiting. Most of that was the last 5-minute window in which nothing landed, which is how I concluded the team was done. Without a feed, "nobody is pushing" and "everyone is finished" look the same.

## 3. Moments where seeing others' work changed what I did

- **9ed854e (a2's NOTES line):** a2 had suggested to a3 that `geo.orderRoute` could post-shorten trips. a3 adopted `tripTimeline` (a0cf71a) but never adopted `orderRoute`. I implemented it in eba749e.
- **c05ed4b (a5's integration test over 60 random days):** this showed me that pipeline-level random testing already existed. I made mine scheduler-level: per-drone overlap, exact timing and range against an independent haversine, and frozen input, instead of duplicating a5's reason checks.
- **41063b4 (a5's no-drones day):** this confirmed that my no-drones test and a5's agree on the "no capacity" reason.
- **5e820f4 (a5 integrated eba749e):** this confirmed that a5's random days already exercise 48 trips with 3+ stops, so the reordering path is covered end to end. That was my signal it was safe to stop.

That makes 4 changes of plan, 2 of them substantive.

## 4. Conflicts, rejected pushes, rebases

- I had no conflicts and no rejected pushes.
- 2 pulls auto-rebased my commit (411fd8a onto a5's dfce6f5, and eba749e onto 41063b4). Both printed `Successfully rebased and updated refs/heads/main.`; I reran the tests and pushed.
- The union merge on NOTES.md worked silently.

## 5. Friction and confusing output

- Taking over from a dead teammate: git cannot tell me whether a3 had local commits, a stash or a half-written change that never reached origin. `git branch -a` showing only `origin/main` is an absence of evidence, not evidence. I had to assume that "what's on main is everything".
- The playbook's bounded wait loop is up to 5 minutes of blocking. Run inside a tool call with a 120 s timeout, my chained `pull; loop; pull; test` got moved to the background, and I had to wait on its output file. That is a mechanics problem rather than a git message problem, but it is the real cost of "there's no feed".
- `git pull` printed `Rebasing (1/1)Successfully rebased...` with no newline between the two parts. This is cosmetic but makes it easy to misread.
- No git output confused me in this run, because the team had essentially converged before I joined.
- A self-inflicted mistake: I once ran plain `git ls-remote` instead of the wrapper, so one call is missing from the usage log.

## 6. Compared with an ideal tool

- **Handover:** an ideal tool would let a replacement agent see a3's unlanded drafts or proposals (work shared but not merged) and a3's open obligations ("a5 asked a3 about X, unanswered"). With git I had to reconstruct everything from the commit log and NOTES prose. That only worked because a3 pushed small and often.
- **Feed instead of polling:** about 10 minutes of sleep loops just to learn that nothing was happening. A push-notification feed, or a "watch this path" with a blocking wait that returns immediately when idle peers are known, would remove that.
- **Ownership-aware notifications:** an alert like "a5 integrated your commit" or "someone touched src/scheduler.js" without reading the whole log. I had to diff NOTES.md by hand to find replies addressed to a3 or a3b.
- **Knowing when a land was safe:** `pull && npm test && push` is fine. But my test run happens on my snapshot, and someone could land between my test and my push. Git only rejects on a non-fast-forward, so a push that passes my local tests can still break main semantically. I'd want the shared server to run the tests on the merged result.

## 7. Features I wanted

1. Visibility of a departed teammate's unpushed or in-progress work, or at least an "a3 last seen / last pushed" view.
2. A feed or subscription (paths, mentions of my name in NOTES) instead of sleep-polling.
3. Server-side "test on merged main before accepting the push".
4. Structured NOTES addressed to an owner (a role, so it moves to a3b automatically), with unanswered items surfaced.

## 8. JSON

```json
{
  "agent": "a3b",
  "usefulness_vs_git": 3,
  "would_choose_hs_over_git_for_this": false,
  "lands_attempted": 3,
  "auto_rebases": 2,
  "real_conflicts": 0,
  "flips_seen": 0,
  "stalls_or_unavailable": 0,
  "used_watch_feed": false,
  "times_others_work_changed_my_plan": 4,
  "proposals_made": 0,
  "reviews_given": 0,
  "review_usefulness": 0,
  "output_clarity": 4,
  "knew_when_my_land_was_safe": 4,
  "confusing_messages": 0,
  "minutes_lost_to_hs": 12,
  "biggest_win": "a3's small, well-described commits plus NOTES.md made the takeover a 5-minute read of git log; pull --rebase + union-merged NOTES gave zero conflicts",
  "biggest_friction": "no way to know whether the dead a3 had unpushed work, and no feed: ~10 minutes of sleep-polling just to learn the team had gone quiet",
  "most_wanted_feature": "role-addressed handover: see a departed owner's unlanded drafts and open questions, and get notified (not poll) when teammates touch or integrate my module"
}
```
