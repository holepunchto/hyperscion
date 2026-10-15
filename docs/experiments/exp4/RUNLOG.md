# Round 4 run log (serial; user approved "recommended, but serially")

Order: s1-hs-1, s1-git-1, s2-git-1, s2-hs-1, s3-hs-1, s3-git-1, s1-git-2, s1-hs-2, s2-hs-2, s2-git-2, s3-git-2, s3-hs-2

Per run:
1. scripts/experiment/setup.sh $S/exp4/<run> <arm> <scenario>
2. date -Iseconds > started.txt; launch 5 general-purpose agents (prompt: "Your complete instructions are in the file .../prompts/aN.md ...") in background
3. s2/s3: node scripts/experiment/inject.js <dir> in background (s3 exits at min 12 -> TaskStop a3 agent, launch a3b from prompts/a3b.md)
4. when all reports written: inject.js --stop; analyze.js; outcomes.js <dir> $S/acceptance/acceptance.js
5. check no leftover bin.mjs processes for the run

Acceptance suite: $S/acceptance/acceptance.js (hidden from agents)

## Status
- s1-hs-1: started 2026-10-14T21:09:10-06:00
  - a2 done (4/5; friction: land silent about 3-way merge of a shared file you edited)
  - a4 done (friction: teammate's merged edit to my file only shown as an incoming line; a1's comment on #2 not in hs status)
  - a1 done (4/5; friction: unclear what watch --count counts when review events print; timeout exit 2)
  - a3 done (4/5; friction: silent CONTRACTS.md merge; 3 agents fixed same rounding bug #16-18 despite NOTES)
  - a5 done (~4/5; friction: status suggested fetch not sync; no signal teammates are finished)
  - SCORED: 21 lands, 0 conflicts, main 100% green, acceptance 100% from min 3.4 (#9), final min 14.7; calls/land 5.05; ratings 4x5; minutes lost 14
- s1-git-1: started
  - a1 done (git 3/5; friction: no feed, sleep+fetch loops, no test-and-push in one step)
  - a4 done (git 3/5; friction: polling; push rejected right after pull said up to date; nothing gates push on tests; flagged a5 --json drops per-stop ETA/price)
  - a2 done (git 3/5; ~10 min in fetch/sleep loops; ORIG_HEAD..HEAD to see what a pull brought)
  - a3 done (git 3/5; 2 of 4 pushes rejected during test runs; wants push that rebases+tests+retries = hs land --check)
  - a5 done (git 3/5; ~10 min fetch loops; nothing ties tests-passed to pushed)
  - SCORED: 22 accepted, 0 conflicts, 3 rejected pushes, 109 polling calls, calls/land 14.2; main 100% green; acceptance 100% at min 2.9 (hs 3.4); last state min 5.3 (hs 14.7); ratings 3x5; minutes lost 44 (hs 14)
- s2-git-1: started
  - !! CONTAMINATION: reading docs/AGENTS-git.md made Claude Code inject docs/AGENTS.md (hs playbook) into git agents (s1-git-1 a2,a3 confirmed; s2-git-1 a2). Fixed for later runs: playbook copied to <teamdir>/playbook.md. Plan: rerun s1-git and s2-git clean at the end (s1-git-3, s2-git-3).
  - s2-git-1 a2 done (git 3/5; a2+a3 fixed same bug in parallel; committed conflict markers mid-rebase; CR-1 done)
  - s2-git-1 a1 done (git 3/5; sleep-20 fetch loops; duplicate window-bug fixes 6fe7e50/962b977; two flight-minute sources for CR-1)
  - s2-git-1 a3 done (git 3/5; shared file w/ a2 no conflicts; duplicate fix; 'taking this' notes only seen on fetch)
  - s2-git-1 a4 done (git 3/5; CR-1 led; duplicate flight-minute source with a2, added agreement test)
  - a5 done (git 3/5; 1 real conflict same refactor of report.js; bfa70e3 failed tests alone, fix right behind)
  - SCORED (contaminated playbook): 32 accepted, 4 real conflicts, 2 rejected, 334 polling calls, 853 calls, calls/land 26.7; main 100% green (push tips); acceptance 100% at 12.2; CR done 2.2 min after pm (min 10.0); ratings 3x5; minutes lost 61
- s2-hs-1: started
  - s2-hs-1 a1 done (4/5; gaps: finding notes addressed to me; seeing lands outside my watch filter)
  - s2-hs-1 a3 done (4/5; 3 real conflicts w/ a2, 2 from parallel CR-1 flight minutes; BUG: rejected land exits 2 = 'done' per playbook; silent merges again)
  - s2-hs-1 a4 done (4/5; CR-1 #26; 1 conflict report.js w/ a5 ~3 min; conflict output one line, no 'other files committed not landed' nor resume hint)
  - s2-hs-1 a2 done (4/5; 1 real conflict w/ a3 (both adopted each other's design); BUG: hs cat silently showed stale pre-sync file; no stash)
  - a5 done (4/5; 7 lands all final; co-owner edits to shared report.js send no review; watch --count without sync returns already-seen cs; no partial land)
  - SCORED: 27 accepted, 5 real conflicts, 0 rejected, 0 polling, 156 calls, calls/land 5.8; main 100% green; acceptance 100% at 13.7 (git 12.2); CR done 2.6 min after pm (git 2.2); last state 24.1 (git 15.2); ratings 4x5, 5/5 choose hs; minutes lost 25 (git 61)
  - hs bugs noted (not fixed mid-series to keep treatment constant): rejected land exits 2; hs cat stale pre-sync; conflict output lacks 'other files committed, not landed' + resume hint
- s3-hs-1: started
  - s3-hs-1 a3 agent id: afa01ba036270a9fe (TaskStop at min 12, then launch a3b)
  - s3-hs-1 a1 done (4/5; no faults hit it; duplicate bug write-up with a5)
  - min 12: a3 stopped (TaskStop), a3b launched (a33b9f6d1fadd5456). faults fired on time: a4 offline 5-12, hub down 8.0-11.0
  - s3-hs-1 a2 done (4/5; during hub outage: sync said 'up to date with #18' while hs knew #19 existed; BUG: doctor told agent to run hs seed)
  - s3-hs-1 a3b done (4/5; recovered a3 context fast via sync+log+NOTES; a3 had left scheduler complete; BUG: hs show P1 diffs proposal vs current main not its base (looks like deletions); a5's watch feed died silently during hub outage; first proposal P1 by a4 approved)
  - s3-hs-1 a4 done (3/5, would NOT choose hs; offline land #12 undone on reconnect, relanded #21; BUGS: feed died silently + restarted feed hung; sync 'up to date #11' while main #16; hs push raw stack trace; show P1 vs current main; land --check merging main reset approval -> 2nd proposal; watch --for-me missed approvals)
  - a5 done (3/5, would not choose; feed silently missed #20-22 in outage; watch on /src timed out despite #21 touching src/report.js; nothing said hub was down; #27 landed with empty message)
  - SCORED: 27 accepted, 0 conflicts, calls/land 7.5, exit errors 8; main 100% green; acceptance 100% at 3.1; NO LANDS min 6.1 -> 15.6 (faults window); last state 52.9 (review/proposal slow); ratings 4,4,4,3,3, 3/5 choose hs; minutes lost 49; wait 107 min
- s3-git-1: started
  - s3-git-1 a3 agent id: a25ca23fd02813eef (TaskStop at min 12, then launch a3b)
  - s3-git-1 a1 done (git 3/5; no faults hit; no feed, manual sha ranges, pull&&test&&push race)
  - s3-git-1 a2 done (git 3/5; polling; didn't know a3 depended on its code until reading commit)
  - s3-git-1 a4 done (git 3/5; 1 rejected push; faults: did a4 even see offline? check trace)
  - s3-git-1 a3 done BEFORE kill (git 3/5; 1 rejected push; will still launch a3b at min 12 for parity with hs run)
  - min 12: a3b launched (a3 already done)
  - s3-git-1 a3b done (git 3/5; a3 left scheduler finished; 3 pushes; ~10 min sleep-polling; can't tell if dead agent had unpushed work)
  - a5 done (git 3/5; 2 rejected pushes; outage error reads like config problem; pull doesn't say what landed)
  - SCORED: 31 accepted, 0 conflicts, 4 rejected, 9 unavailable, 179 polling, calls/land 15.3; main 100% green; acceptance 100% at 2.3; no pushes min 5.5 -> 12.7; last 15.1; ratings 3x6; minutes lost 47 (hs 49)
  - DESIGN: s3 faults too late (agents done by ~min 5). Second S3 pair uses scenario s3e: a4 offline 2-7, origin down 3-6, kill a3 at 4 (inject exits after kill at 4 -> must keep running for later events!)
- s1-git-2: started
  - s3e kill wake-up: run background 'until [ -f <dir>/faults/a3.dead ]; do sleep 2; done'
  - harness fix mid-run (s1-git-2): git-trace EPIPE crash when piped to head
  - s1-git-2 a1 done (git 3/5; 3 pushes clean; sleep/fetch loops; hit EPIPE wrapper bug)
  - s1-git-2 a3 done (git 3/5; 5 pushes, 0 rejects; polling; a2 advice raced a3's commit)
  - s1-git-2 a4 done (git 3/5; 5 pushes 0 rejects; after pull the playbook's 'git log HEAD..origin/main' shows nothing)
  - s1-git-2 a2 done (git 3/5; 6 pushes clean; stale NOTES advice race)
  - a5 done (git 3/5; 7 pushes 0 rejects)
- s1-hs-2: started
  - s1-git-2 SCORED: 26 accepted, 0 conflicts, 0 rejected, 127 polling, calls/land 12.7; main 100% green; acceptance 100% at 2.2; last 7.5; ratings 3x5; lost 39
  - s1-hs-2 first setup failed: 'a1 did not become writable' (kept as exp4/failed-s1-hs-2-setup); retried OK
  - INVESTIGATE LATER: failed setup hub log has no 'admitted a1.key' but a1.key is gone from admit dir -> admitLoop may drop a key dropped early (before seed ready?)
  - s1-hs-2 a2 done (4/5; silent CONTRACTS merge again; wants watch to sync after wait)
  - s1-hs-2 a1 done (4/5; status says 'hs fetch' where sync expected (2nd time); 'untested' warning on NOTES-only land)
  - s1-hs-2 a4 done (4/5; gain is ergonomics+feed, not merging; feed cluttered with settled lines + long hashes)
  - s1-hs-2 a3 done (4/5, would choose hs; wants blame; wants land to say which files were silently merged)
  - a5 done (4/5; 8 lands final; wants 'teammates finished' signal + stale-note warning)
  - s1-hs-2 SCORED: 29 accepted, 0 conflicts, calls/land 3.6, 105 calls; main 100% green; acceptance 100% at 3.7; last 13.8; ratings 4x5, 5/5 choose; lost 11
- s2-hs-2: started
  - s2-hs-2 a2 done (4/5; 4 silent merges of a3 edits into scheduler.js; 1 real conflict; BUG: status doesn't show leftover conflict markers; 3 agents started CR-1 flight minutes)
  - s2-hs-2 a4 done (4/5 would choose; CR-1 #34; check caught 1 failure pre-main; triple CR-1 flight-minute work; wants WIP announce; per-section ownership)
  - s2-hs-2 a5 done (4/5; 8 lands 0 conflicts; watch --path fires on any change to shared file; co-owner edits no review; '#34' needs quoting in shell)
  - s2-hs-2 a3 done (4/5; 10 lands final; 1 conflict with coarse whole-file markers; triple CR-1 work)
  - a1 done (4/5; watch timeout 600 = agent shell limit; status suggests fetch not sync (3rd))
  - s2-hs-2 SCORED: 37 accepted, 2 conflicts, calls/land 4.4, 164 calls; main 100% green; acceptance 100% at 12.6; CR done 1.5 min after pm (11.1); last 13.7; ratings 4x5, 5/5; lost 22
- s2-git-2: started
  - s2-git-2 a1 done (git 3/5; 2 pushes clean; polling; duplicate flightMinutes a2/a3)
  - s2-git-2 a2 done (git 3/5; 0 conflicts via section markers in scheduler.js; duplicate flightMinutes rebased in silently)
  - s2-git-2 a4 done (git 3/5; CR-1 98f63cb; 4 agents wrote flight-minutes despite NOTES claim; ~25-30 min fetch/sleep)
  - s2-git-2 a3 done (git 3/5; 1 real conflict; 1 rejected push; duplicate flightMinutes removed 256c634; ~7 polling loops)
  - a5 done (git 3/5; 11 pushes; 1 conflict report.js; ~30 min fetch loops; competing money blocks with a4)
  - s2-git-2 SCORED (clean): 31 accepted, 2 conflicts, 2 rejected, 339 polling, 835 calls, calls/land 26.9; main 100% green; acceptance 100% at 12.5; CR done 2.5 min after pm (10.0); last 23.9; ratings 3x5; lost 54
- s3e-git-2: started
  - s3e-git-2 a3 agent id: ac536bef6618fc1f1 (TaskStop when bjmttri39 fires at min 4, launch a3b)
  - min 4: a3 stopped mid-work (had committed locally while origin down -> unpushed work lost), a3b launched
  - s3e-git-2 a1 done (git 3/5; 3 pushes first try; outage msg reads like config error; silent rebase made NOTES stale)
  - s3e-git-2 a2 done (git 3/5; 6 pushes 0 conflicts; misleading outage error; no queued push)
  - s3e-git-2 a4 done (git 3/5; offline+outage: blind ~5 min while 15 commits landed; 1 rejected push; wants watch files/mentions + peer fetch when origin down)
  - s3e-git-2 a3b done (git 3/5; TAKEOVER DURING OUTAGE: clone showed only skeleton, git status 'up to date' -> rebuilt scheduler a3 had landed (~10 min waste), nearly pushed competing Plan shape; a3's local commit lost)
  - a5 done (git 3/5; 10 pushes 0 rejects)
  - s3e-git-2 SCORED: 27 accepted, 0 conflicts, 1 rejected, 241 polling, 56 unavailable, 560 calls, calls/land 20.7; main 100% green; acceptance 100% at 2.2; NO PUSHES min 2.2 -> 6.2 (outage 3-6); last 9.9; ratings 3x5; lost 41
- s3e-hs-2: started
  - s3e-hs-2 setup FAILED again (a1 not writable) and agents were launched for ~1 min before abort (stopped all, no faults applied). ROOT CAUSE (harness, not hs): team.sh piped clone into `head -1`, which can kill clone before it writes the admit key. Fixed in team.sh. Retract earlier 'admitLoop drops key' suspicion.
- s3e-hs-2 (retry): started OK; a3 agent id aafc910c8cdd59006 (TaskStop when b881x433a fires, launch a3b)
  - min 4: a3 stopped, a3b launched
  - s3e-hs-2 a1 done (4/5; --check caught clash; BUGS: feed silently stopped at #10 after outage, offline land #11 undone w/o notice in feed, hs push raw stack trace, hs restore said restored but left edit)
  - s3e-hs-2 a2 done (4/5; KEY: during hub outage sync 'up to date #9' while feed had #10 -> peers did NOT serve; hs show 10 stack trace; hs cat stale silently; a3b filled idle gaps #24 after a2 note)
  - s3e-hs-2 a4 done (4/5; offline: sync 'up to date #3' while feed #5; show 5 stack trace exit 0; offline land silently #4->#14; stale hint says fetch but sync needed; feed died silently)
  - s3e-hs-2 a3b done (~3/5 'on par'; SAME TAKEOVER FAILURE AS GIT: sync 'no peers found ... up to date #1' while main had #14 -> rewrote a3's scheduler; hs restore wouldn't discard conflict; watcher hung. => hs agents do not find/serve each other without the hub — key product finding)
  - a5 done (4/5; feed went silent after outage while process alive; hs push stack trace)
  - s3e-hs-2 SCORED: 27 accepted, 1 conflict, 9 exit errors, 221 calls, calls/land 8.2; main 100% green; acceptance 100% at 6.0; gap min 4.1 -> 7.1 (outage 3-6); last 11.6; ratings 4,4,3,4,4, 4/5 choose; lost 48
- s1-git-3 (clean rerun): started
  - s1-git-3 a1 done (git 3/5; ~10 min sleep/fetch; interface landed 5th so teammates wrote own normalization)
  - s1-git-3 a2 done (git 3/5; 4 pushes clean; pull doesn't say what rebase brought, a3's contract change arrived silently)
  - s1-git-3 a4 done (git 3/5; pull quietly merged a5's edit to own report.js — same silent-merge complaint as hs arm)
  - s1-git-3 a3 done (git 3/5; 6 pushes clean; polling; pull doesn't say what you rebased onto)
  - a5 done (git 3/5; 9 pushes; coordination came from conventions not git; no 'team done' signal)
  - s1-git-3 SCORED: 26 accepted, 0 conflicts, 0 rejected, 108 polling, 309 calls, calls/land 11.9; main 100% green; acceptance 100% at 2.5; last 5.8; ratings 3x5; lost 39
- s2-git-3 (clean rerun): started
  - s2-git-3 a2 done (git 3/5; 2 real conflicts (both adopted each other's split; parallel CR-1 flight minutes); 1 rejected)
  - s2-git-3 a3 done (git 3/5; ~6 clean rebases on shared file; 1 rejected; crossed replies; duplicate rounding fix; 4 agents built CR-1 flight minutes)
  - s2-git-3 a4 done (git 3/5; 5 pushes, 1 conflict report.js; crossed adaptations with a5; 4 agents wrote CR-1 flight minutes)
  - s2-git-3 a1 done (git 3/5; 2 rejected pushes; broken main went unnoticed until local tests)
  - a5 done (git 3/5; ~25 min blind fetch loops; no CI on main)
