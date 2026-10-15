# Multi-agent experiments

**Setup** (same in both runs):

- 5 AI agents (a1 model, a2 geo, a3 scheduler, a4 pricing/report, a5 cli/integration) build
  "Skyhop", a drone-delivery planner, in parallel.
- Agents coordinate **only** through `hs` over the public DHT. A hub runs `hs seed --mirror`.
- No git. No reading other agents' worktrees.
- Every `hs` call is traced, and each agent writes a candid report with a scorecard.

The harness is in `scripts/experiment/` (see its README) and `scripts/team.sh`.

**Limits:** these are single runs, with no git control team, and the agents know git much
better than hs.

## Results side by side

|                                                        | experiment 1 (milestone 1)                        | experiment 2 (milestone 2)                  |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| usefulness vs git (1–5, all five agents)               | **2, 2, 2, 2, 2**                                 | **4, 4, 4, 4, 4**                           |
| would choose hs over git for this                      | 0 / 5                                             | 5 / 5                                       |
| product on main                                        | 26 changesets, 63/63 tests, CLI works             | 27 changesets, 61/61 tests, CLI works       |
| hs calls                                               | 654                                               | 129                                         |
| `pull` calls (polling)                                 | 262 (one agent: 111)                              | **0**: agents used `hs watch`               |
| content stalls ("stalled waiting for data")            | 30–77 per agent transcript, 8–10 min blocked each | **0**                                       |
| near-silent reverts (stale files shown as edits)       | 3 agents hit it, caught by hand                   | **0** (stale files are never edits)         |
| lands undone by a reorg                                | 1, nobody told                                    | 0 happened (banner and restore are tested)  |
| land rejections                                        | 13 (plus 1 stale-base)                            | 10 auto-rebased and landed, 1 real conflict |
| NOTES.md conflict markers                              | every concurrent append                           | **0** (union merge)                         |
| times a teammate's landed work changed an agent's plan | 24                                                | 23                                          |

Both runs built working software. What changed is the friction. In experiment 1, agents spent
much of their time on stalls, polling and checking for reverts. In experiment 2:

- they watched a feed;
- they landed in one command that rebased itself;
- they read teammates' changes as diffs (`hs show`);
- they waited on dependencies with `hs watch --path <file> --count 1`.

## Experiment 3 (milestones 3–5: review, finality, CLI defaults)

Same setup and task, on the public DHT. `scripts/experiment/analyze.js` now writes
`metrics.json`, and `compare.js` puts rounds side by side:

|                                   | exp 2         | exp 3         |
| --------------------------------- | ------------- | ------------- |
| usefulness vs git                 | 4, 4, 4, 4, 4 | 4, 4, 4, 4, 4 |
| would choose hs                   | 5/5           | 5/5           |
| hs calls / minutes                | 129 / 23.9    | 100 / 18.2    |
| calls per accepted land           | 4.96          | **3.7**       |
| lands accepted / attempted        | 26 / 27       | **27 / 27**   |
| real conflicts                    | 1             | **0**         |
| lands that ended final            | n/a           | **27 / 27**   |
| land p50 / p90                    | 2.6 s / 2.9 s | 2.8 s / 3.2 s |
| `-o` / `pull` (old habits)        | 27            | **0**         |
| output clarity (1–5)              | n/a           | 4.2           |
| knew when a land was safe (1–5)   | n/a           | 4.8           |
| confusing messages / minutes lost | n/a           | 7 / 12        |
| proposals / reviews / Shows       | 0 / 0 / 0     | 0 / 0 / 0     |

The product: 28 changesets, 69/69 tests from a fresh clone, and the CLI plans 18/19 packages.

**Why the rating stayed at 4.** Nothing went wrong. Every agent said, in one form or another,
that this task is well partitioned (one owner per file, append-only shared files), so git with
a union attribute and `pull --rebase` would be "about 80% as good". hs's differentiators never
came into play:

- no lands were reordered, so finality only showed `final`;
- nobody touched another owner's files, so review was never triggered;
- the hub never went down, so availability was never tested.

The task design caps the score, not the tool.

**What experiment 3 found:**

1. **Lands publish merged states nobody tested (4/5 agents; the most-wanted feature for 3).**
   `land` rebases onto teammates' changes and publishes immediately. Wanted: `land --check
"npm test"`, which runs on the rebased tree and refuses to land if it fails.
2. **`watch --count` counts `settled` events (2/5; a bug).** Without `--path`, a watch exited
   on `@ settled through #n` lines without printing the changesets.
3. **The incoming list hides the oldest entry** behind `... and 1 earlier (hs log -f)`, which
   also names a flag that is now hidden.
4. **`log --oneline` prints two lines**, and **`log`/`status` don't say how far behind main
   you are**.
5. **Smaller requests:**
   - `show <n> --path <p>`;
   - `watch --path` with globs or several paths;
   - "changeset(s)" wording in `--for-me` timeouts;
   - exit 2 is overloaded for watch timeouts;
   - an amend for your own provisional land.

**Status after the follow-up:**

- All addressed except globs in `watch --path` and amend.
- Fixes:
  - `land --check <cmd>`;
  - `--count` counts changesets only, and feeds never print `settled through #n` before #n;
  - the incoming list shows everything, oldest first, before the `landed #n` line, and warns
    when a land sits on untested changes;
  - a true `log --oneline`;
  - `log` and `status` say when the feed knows main is ahead;
  - `show --path`;
  - `--for-me` timeouts say "event(s)".
- `test/cli.js` covers each one.

## Experiment 4: hs against a git control team

14 runs, run one after another. Each run had five agents (a1–a5, the same roles as before),
so 70 agents in all, plus four stand-ins (a3b) in the fault runs. There were three
scenarios, each run on both arms (hs and git, see "Round 4 design" below):

| scenario | what it adds                                                                           |
| -------- | -------------------------------------------------------------------------------------- |
| S1       | baseline, same task as experiment 3                                                    |
| S2       | shared files, plus a change request from a "pm" at minute 10                           |
| S3       | faults: the hub or origin goes down, one agent goes offline, a3 is killed and replaced |
| S3e      | S3 with the faults earlier (see caveats)                                               |

The raw data (reports, prompts, traces, metrics and per-state outcomes for each run) is in
`docs/experiments/exp4/`, and its `RUNLOG.md` has a line for every run.

### Results

All outcome metrics come from replaying main (`outcomes.js`); the self-ratings come last.
"main green" is the share of main states that pass the team's own `npm test`. "Acceptance"
is the hidden 25–27 check suite.

| run         | calls | lands | calls/land | polling | conflicts | rejected pushes | main green | acceptance 100% at | change request done after | last land | rating | would choose hs | min lost (self) |
| ----------- | ----- | ----- | ---------- | ------- | --------- | --------------- | ---------- | ------------------ | ------------------------- | --------- | ------ | --------------- | --------------- |
| s1-hs-1     | 106   | 21    | 5.1        | 0       | 0         | 0               | 100%       | 3.4 min            | –                         | 14.7      | 4.0    | 5/5             | 14              |
| s1-hs-2     | 105   | 29    | 3.6        | 0       | 0         | 0               | 100%       | 3.7                | –                         | 13.8      | 4.0    | 5/5             | 11              |
| s1-git-1 \* | 312   | 22    | 14.2       | 109     | 0         | 3               | 100%       | 2.9                | –                         | 5.3       | 3.0    | –               | 44              |
| s1-git-2    | 330   | 26    | 12.7       | 127     | 0         | 0               | 100%       | 2.2                | –                         | 7.5       | 3.0    | –               | 39              |
| s1-git-3    | 309   | 26    | 11.9       | 108     | 0         | 0               | 100%       | 2.5                | –                         | 5.8       | 3.0    | –               | 39              |
| s2-hs-1     | 156   | 27    | 5.8        | 0       | 5         | 0               | 100%       | 13.7               | 2.6 min                   | 24.1      | 4.0    | 5/5             | 25              |
| s2-hs-2     | 164   | 37    | 4.4        | 0       | 2         | 0               | 100%       | 12.6               | 1.5                       | 13.7      | 4.0    | 5/5             | 22              |
| s2-git-1 \* | 853   | 32    | 26.7       | 334     | 4         | 2               | 100%       | 12.2               | 2.2                       | 15.2      | 3.0    | –               | 61              |
| s2-git-2    | 835   | 31    | 26.9       | 339     | 2         | 2               | 100%       | 12.5               | 2.5                       | 23.9      | 3.0    | –               | 54              |
| s2-git-3    | 888   | 30    | 29.6       | 368     | 3         | 4               | 96.8%      | 11.8               | 1.8                       | 21.4      | 3.0    | –               | 64              |
| s3-hs-1     | 203   | 27    | 7.5        | 0       | 0         | 0               | 100%       | 3.1                | –                         | 52.9      | 3.6    | 3/5             | 49              |
| s3-git-1    | 473   | 31    | 15.3       | 179     | 0         | 4               | 100%       | 2.3                | –                         | 15.1      | 3.0    | –               | 47              |
| s3e-git-2   | 560   | 27    | 20.7       | 241     | 0         | 1               | 100%       | 2.2                | –                         | 9.9       | 3.0    | –               | 41              |
| s3e-hs-2    | 221   | 27    | 8.2        | 6       | 1         | 0               | 100%       | 6.0                | –                         | 11.6      | 3.8    | 4/5             | 48              |

\* the hs playbook leaked into these git agents' context (see caveats). Their trace and replay
numbers match the clean git runs.

Per arm:

- "calls" counts tool calls; for git that's `git` calls, so there are no exit errors to compare.
- "Rating" is `usefulness_vs_git`. On the git arm it means "how well did git serve the
  team compared with an ideal tool", so the two arms' ratings measure different things and
  can't be compared directly.

### What we learned

1. **The product was the same with either tool.**
   - Every run ended with the same working planner: 18 of 19 packages delivered, p19
     unassigned, main green, acceptance at 100%.
   - In 14 runs main went red once (s2-git-3: one push by a4 at minute 4.6, fixed by the
     next push).
   - The hidden suite reached 100% within 2–4 minutes in S1 and S3, and at about minute 12–14
     in S2 on both arms, since S2 has to wait for the change request.
   - The change request was finished 1.5–2.6 minutes after it landed, on either arm.
2. **git is faster to finish; hs is far cheaper to coordinate.**
   - git's last change came earlier in S1 (about minute 5–8 vs about 14), because a push to a
     local origin takes milliseconds and git agents stop sooner.
   - hs used 2–5 times fewer calls, made no polling calls (`watch` replaced them), had no
     rejected pushes or lands, and agents reported a half to a third as many lost minutes
     (S1 11–14 vs 39–44; S2 22–25 vs 54–64).
   - Waiting was explicit in hs: `wait_min_total` 14–107 minutes per run, spent blocked in
     `watch`. That can't be measured for git (its sleep loops aren't traced), but it showed up
     as up to 368 polling calls.
3. **Duplicated work is the biggest waste, and neither tool prevents it.**
   - In every S2 run, on both arms, 2–4 agents built the change request's flight minutes in
     parallel. Agents duplicated it even after another agent had claimed it in NOTES.md.
   - The same happened on a smaller scale: two fixes for one bug, crossed "I'll adopt your
     design" replies.
   - Silent clean merges hide it in both tools.
   - The most-wanted feature on both arms was announcing work in progress ("I'm taking X").
4. **Faults: hs gave no availability advantage.**
   - With the hub down, hs agents didn't find or fetch from each other, even though four
     online peers held the data. `sync` said "no peers found … up to date with main #1"
     while main was at #14.
   - Both arms went quiet for the outage: hs 4.1→7.1 min, git 2.2→6.2 min (S3e). Both
     stand-ins (a3b) started during the outage and rebuilt a scheduler a3 had already landed:
     git's clone showed only the skeleton, and hs's sync showed #1.
   - In S3, hs's last land came at minute 52.9, held up by a proposal/review cycle.
   - Self-reported lost time in the fault runs was about equal (48–49 vs 41–47).
5. **Agents rated hs 4/5 in every normal run and 3.6–3.8 in the fault runs**, with 3–4 of 5
   choosing hs there. Every git agent gave git 3/5 ("adequate"). In their reports, the git
   agents most often wanted:
   - a feed;
   - blocking waits;
   - a tested push that retries by itself;
   - a "main is green" signal.

   These are what hs already has.

### hs bugs found (not fixed during the series, so every hs run used the same build)

Outage and offline handling, which is the top priority:

- Peers don't serve each other when the hub is down: there's no peer-to-peer fallback for
  `sync`/`fetch`.
  **Why:** only `hs seed` joins the swarm as a server (`lib/cli.js`, `online()` defaults to
  `server: false`, and so does `watch`). Agents never announce, so with the hub gone they
  can't find each other at all. A long-running `watch` announcing would likely fix most of it.
- `sync` reports "up to date with main #n" when its own feed or other peers know a newer main.
- Feeds (`watch --json`) go silent on an outage while the process stays alive. A restarted
  feed can hang, and a land undone on reconnect isn't reported in the feed.
- `hs push` and `hs show <n>` print raw stack traces; `show` exits 0.
- An offline land is renumbered silently (#4 → #14).
- `hs doctor` tells agents to run `hs seed`.
- Nothing says "the hub is unreachable".

Correctness and messages:

- `hs cat` returns a stale (pre-sync) file without a warning.
- `hs restore` says "restored" but leaves the edit.
- A land rejected by a conflict exits 2 ("done, read the !! lines"). Its output is one line and
  doesn't say the other files were committed but not landed, or how to resume.
- `status` doesn't show files that still have conflict markers.
- Hints say `hs fetch` where `hs sync` is what's needed (4 agents).
- Lands don't say when they merged a teammate's change into a file you edited (raised in
  almost every hs run).

Review:

- `hs show Pn` diffs against the current main, not the proposal's base, so it looks like a
  proposal deletes teammates' lines.
- A content-identical rebase resets approvals.
- `watch --for-me` missed approvals.
- Co-owners of a file get no review requests for each other's edits.
- A land had an empty message.

Smaller asks:

- `watch --path` fires on any change to a shared file;
- `#34` needs quoting in shells;
- feed clutter (settled lines, long hashes);
- blame;
- stash;
- partial land;
- a "team is done" signal.

**Status after the follow-up.** Each fix is covered by `test/outage.js` or `test/fixes.js`.

Fixed:

- **Feeds are holders.**
  - A long-running `hs watch` now announces itself, mirrors every landed file and rejoins
    after losing all peers.
  - So while the hub is down, teammates land and sync through each other's feeds.
  - The stand-in case from S3e is a probe: a3b syncs a3's landed work from a2's feed.
- **Agents are told about outages.**
  - Feeds print `offline`/`online` lines, debounced so short commands don't flap them.
  - `sync` with nobody reachable says `!! no peers reachable: showing local main #n (your
feed has seen #m)` and exits 2; it no longer says "up to date".
  - `push` with nobody reachable gives a plain warning instead of a stack trace.
  - The holder hint no longer tells agents to run `hs seed`.
- **No more stack traces.**
  - paparam passed command errors on as their stack text, so every command error printed
    one; `bin.mjs` now prints the message only (`HS_DEBUG=1` for the stack).
- **Lands that don't happen are clear.**
  - They exit 1 with `!! not landed: <why>`, list the changed files kept in the workspace,
    and give the next step.
  - Merges into files you edited are reported (except union files such as `NOTES.md`).
- **Smaller fixes:**
  - `status` lists files that still have `<<<<<<<` markers.
  - `restore` drops committed-but-unlanded edits too, and `changes()` ignores entries
    rewritten unchanged.
  - Lands without `-m` get the proposal's message or `update <paths>`.
  - `cat` catches up when the feed knows a newer main.
  - `show P<n>` diffs against the proposal's base.
  - `watch --for-me` resumes from the last event it showed you.
  - Stale-file hints say `hs sync`.

Not fixed:

- **Approvals reset when main's changes merge into the proposal's files.** Approvals are
  pinned to the full content, so a merge resets them. Keeping them needs approvals pinned to
  the proposal's diff, which is a design change. An earlier attempt hashed content instead of
  entries, but it changed how every peer computes approval state and wasn't shown to fix
  the reported case, so it was reverted.
- A land made offline and renumbered on reconnect isn't announced in the feed; `status`
  shows the undone-land banner.
- From the smaller asks: `watch --path` precision within a file, blame, stash, partial land,
  a "team is done" signal, and work-in-progress claims.

### Caveats

- **Playbook leak.** In runs s1-git-1 and s2-git-1, reading `docs/AGENTS-git.md` made Claude
  Code also load `docs/AGENTS.md`, the hs playbook, as directory instructions. a2 reported it in
  both runs, and a3 in s1-git-1 cited `hs land --check` as its ideal. No git agent in the
  later runs mentioned it. From then on the playbook
  is copied into the team directory, and clean reruns (s1-git-3, s2-git-3) were added. Trace
  and outcome numbers match the clean runs.
- **S3 fired too late.** Its faults started at minute 8, when most agents in both arms were
  already done. `s3e` moves them to minutes 2–7, so the two S3 runs are a pair of different
  scenarios, not a replication.
- **One git run per S3 variant.** S3 and S3e each have one hs run and one git run.
- **Asymmetry.** git's origin is on the local disk; hs runs over the public DHT. hs land
  latency (p50 about 3–4 s against git's 25 ms) reflects that.
- **Harness fixes during the series.** The git trace wrapper crashed on EPIPE when piped
  into `head`; fixed in run 7. Two hs setups failed because `team.sh` piped `clone` into
  `head -1`, which could kill it before it wrote the admit key. One of those launched agents
  for about a minute before it was aborted. Both setups were redone (kept as
  `failed-*-setup`).
- **A flaw in the git playbook.** Two git agents found that `git log HEAD..origin/main` shows
  nothing after `git pull`, because the pull already moved the branch. It was never fixed, so
  it affected every git run equally.
- **No blind judge.** The judge from the design wasn't run. The 14 final trees are still in
  the session scratchpad if it's wanted; with identical outcomes it would mostly measure duplication, which the reports
  already document.
- **What the metrics don't show.**
  - Acceptance saturates early, because the task is small for these agents.
  - Main health counts only states pushed or landed to main, not intermediate commits.
  - Self-ratings use different scales per arm.

### Next

1. Make the hub optional in practice: peers serve and fetch from each other when the hub is
   down, `sync` says when it couldn't reach anyone, and feeds survive and report outages.
   Then rerun S3e.
2. Fix the correctness and message bugs above, and give conflicts a resumable flow.
3. Add work-in-progress claims (`hs claim <path|topic>` shown in feeds and `status`), aimed at
   the duplication that both arms share. Measure it in S2.
4. Make the scenario harder, so outcomes, not just effort, can separate the tools: bigger
   tasks, or a longer horizon with several change requests.

## Quick loop: first q1 pair (after the experiment 4 fixes)

This is scenario `q1`, the first pair on the fast loop (see `scripts/experiment/README.md`):

- 3 agents, about 5–7 minutes of work;
- the hub or origin is down from minute 2 to 4;
- the change request is due at minute 3.

The data is in `docs/experiments/quick/`. This is a new baseline, not comparable with
experiment 4.

|                                | hs                  | git                               |
| ------------------------------ | ------------------- | --------------------------------- |
| tokens, wall time              | about 193k, 4.8 min | about 167k, 7.5 min               |
| calls (per accepted land)      | 54 (4.9)            | 181 (18.1)                        |
| polling calls; "unavailable"   | 0; 0                | 74; 20                            |
| errors; stack traces           | 0; 0                | 20 (fetches during the outage); – |
| main green; acceptance 100% at | 100%; minute 3.9    | 100%; minute 5.1                  |
| change request landed; done in | minute 3.0; 0.9 min | minute 4.3 \*; 0.8 min            |
| ratings; minutes lost (self)   | 4, 4, 4; 2          | 3, 3, 3; 5                        |

\* On git the change request couldn't land while the origin was down. The injector's retries ran
out just as the origin came back, and it was landed by hand about 20 s later. The retry budget
is now 10 minutes.

**What it showed:**

- **The fixes work with real agents.**
  - The change request and three agent lands went through feeds while the hub was down. They
    stayed provisional, then became final when the hub returned.
  - No `sync` reported "no peers", and nothing printed a stack trace.
  - The one not-landed outcome printed the new three-line message.
- **Remaining gap: nobody is told the hub is down.**
  - Feeds stay connected to each other, so they never go offline.
  - Settling stalls silently, and one agent "never saw" the outage.
  - Next fix: feeds and `status` say when the hub (indexer) isn't reachable or lands aren't
    settling.
- **Also seen:**
  - `watch --count 1` without a prior `sync` returns a changeset you've already seen (twice).
  - `status` shows provisional after the feed said final, until a `sync`.
  - All three agents built the change request's flight minutes in parallel, on both arms
    again. That's the duplication problem from experiment 4.
- **On the git arm,** one agent set `would_choose_hs_over_git_for_this` to true despite the
  instructions, so that field is meaningless there.

## Round 4 design: a git control team and scenarios that matter

Round 3 hit a ceiling: the task was so well partitioned that git would have done "about 80%
as well", and agents rated hs against an imagined git. Round 4 replaces the imagined git with a
real one, and uses scenarios where hs's differences should show.

### Arms

Every scenario runs twice, once with each tool. Same skeleton, roles, model, timing and
prompt template. Only the tool section and the playbook differ.

- **hs:**
  - `scripts/team.sh`, on the public DHT, with a hub running `hs seed`;
  - the playbook is `docs/AGENTS.md`;
  - land with `--check "npm test"`.
- **git:** a bare `origin` on the local filesystem, standing in for an always-up GitHub
  without a UI. It gets the best reasonable setup, so we're not beating a straw man:
  - `.gitattributes` with `NOTES.md merge=union`;
  - a playbook just as good (`docs/AGENTS-git.md`): `pull --rebase`, run `npm test` before
    every push, retry on rejection, poll with `git fetch && git log origin/main`;
  - Ask by pushing an `ask/<topic>` branch and noting it in `NOTES.md`.
  - Every `git` call goes through a traced wrapper, the same as `hs-aN`.

The asymmetry is stated, not hidden: git's origin is local and never slow, while hs uses the
public DHT.

### Scenarios

| scenario        | what changes from round 3                                                                                                                                                                                                                                             | what it tests                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **S1 baseline** | nothing (Skyhop, one owner per file)                                                                                                                                                                                                                                  | control: is git really about 80% as good?                          |
| **S2 overlap**  | Pairs share files: a2+a3 both own `scheduler.js` (capacity vs timing), a4+a5 both own `report.js`. At minute 10 a "pm" writer lands a change request: pricing becomes per-minute, which changes a contract owned by a4 and consumed by everyone.                      | real conflicts, `--check`, Show/Ask, how contract changes spread   |
| **S3 faults**   | S1 plus scheduled faults from an injector: the hub/origin is down from minute 8 to 11; a3 is killed at minute 12, and a fresh agent a3b continues a3's work from what landed (and a3's open proposal, for hs); a4 works offline from minute 5 to 12, then reconnects. | availability, recovery, offline work, finality under real reorders |

The injector (`scripts/experiment/inject.js`) runs the same schedule for both arms:

- it kills and restarts `hs seed`, or for git renames `origin` away;
- it stops and starts agents;
- it lands or commits the change request as "pm".

### Metrics: outcomes first, self-ratings last

Each round writes `metrics.json`, and `compare.js` sets arms and rounds side by side. Most
metrics are computed after the run, so agents can't game them.

1. **Product quality: a hidden acceptance suite.** I write it before the run and the agents
   never see it. Reported as the % passing on final main.
2. **Main health.** Replay main and run `npm test` at every changeset or commit. Reported as
   the % of green states on main, the longest red streak in minutes, and red states
   introduced by untested merges. This needs `hs checkout --at <seq>`, or a library replay;
   for git, `git checkout <sha>`.
3. **Integration latency.** For each producer→consumer dependency (model→scheduler,
   scheduler→report, …): minutes from the producer's land to the consumer's first land
   that uses it.
4. **Blocked time.** Minutes agents spent waiting: `watch` calls, poll loops, failed pushes
   or lands and their retries.
5. **Tool overhead:**
   - VCS calls per accepted land;
   - VCS wall time as a share of agent wall time;
   - error and warning exits;
   - `--help` calls.
6. **Conflicts:** real conflicts, minutes from a conflict to the next good land, and work lost.
7. **Fault recovery (S3):** minutes each agent stalled during the outage, lands that waited
   or failed, and whether a3b recovered a3's in-progress work.
8. **Rework and duplication:** lines landed by one agent and rewritten by another, plus
   duplicate implementations. A judge agent that doesn't know which arm produced the code
   rates the final code.
9. **Self-ratings, kept but demoted.** The scorecard as in round 3. The git arm rates git
   against an "ideal tool" on the same scale.

### Runs and cost

LLM runs are noisy, so one run per cell is an anecdote.

- **Minimal:** S2 and S3, both arms, one run each. That's 4 runs (20 agents), about 2M
  tokens.
- **Recommended:** S1, S2 and S3, both arms, two runs each. That's 12 runs (60 agents),
  about 6M tokens.

### Harness work before round 4

1. `scripts/git-team.sh`: a bare origin, 5 clones, traced `git` wrappers, the skeleton and
   `.gitattributes`.
2. `docs/AGENTS-git.md`, a git playbook as good as ours, plus per-arm sections in
   `agent-prompt.md`.
3. Scenario folders (`scripts/experiment/scenarios/{s1,s2,s3}`) with roles, the skeleton
   delta and the fault/change schedule; `inject.js` to run the schedule.
4. The hidden acceptance suite (`scripts/experiment/acceptance/`).
5. Main-health replay: `hs checkout --at <seq>` (useful on its own) and `replay.js` for both
   tools.
6. `analyze.js` reading git traces into the same `metrics.json`.

**Status: built.**

- **Setup and scenarios:**
  - `scripts/git-team.sh` and `docs/AGENTS-git.md`;
  - `agent-prompt-git.md`;
  - `scenarios/s1..s3` with overlays, roles and schedules;
  - `inject.js`;
  - `setup.sh` (one command per run).
- **Scoring:**
  - `hs export <dir> --at <seq>` (instead of a checkout; it doesn't touch a worktree);
  - `outcomes.js`, which replays main for both arms;
  - `analyze.js` for git traces.
- **Acceptance suite:**
  - It's kept out of the repo while the runs happen and tests only through the `--json` shape,
    which is now pinned in the skeleton's CONTRACTS.md.
  - On experiment 3's final main, adapted to that shape, it passes 27/27.
- **Dry runs:** both arms ran with compressed timelines and every fault and the change request
  fired.
  - One finding already: in the hs arm, a4's offline land `#2` became `#3` when it
    reconnected, and nothing was lost.
- **Not built:** the blind judge (not run; see experiment 4 caveats).

**Run order** (serial, arms alternating, the second run of each scenario with the other arm
first):

1. s1-hs-1, s1-git-1;
2. s2-git-1, s2-hs-1;
3. s3-hs-1, s3-git-1;
4. s1-git-2, s1-hs-2;
5. s2-hs-2, s2-git-2;
6. s3-git-2, s3-hs-2.

## What experiment 2 still found

Each item is ranked by how many agents raised it.

1. **Clean auto-rebases print "conflict on N path(s)" (4/5 agents).** It reads as an error even
   though the land then goes through. It should read as information ("main moved, rebasing
   onto it…").
2. **Lands never stop being "provisional" (4/5).** `status` says provisional long after later
   lands are on top. Agents want an explicit "final" signal. This is the finality item in
   DESIGN.md §8.1, now a real user request.
3. **`watch --count 1` can wait on something that already happened (3/5).** a5 blocked for
   500 s on a file that had already landed. `--since <seq>` exists but the playbook didn't say
   to use it. Needed: `--since` defaulting to the workspace base when `--path` is given, and a
   `--timeout`.
4. **Stopping your own watcher is unsafe (4/5).** a1 ran `pkill -f "bin.mjs watch"` and killed
   every agent's feed, because the process command line doesn't identify the agent. Restarted
   feeds don't backfill what they missed. Needed: `hs watch --stop` (pidfile in `.hs/`), and
   feeds that resume from the last seq they printed.
5. **`sync`/`land` don't say what came in (3/5).** Wanted: a one-line summary of incoming
   changesets (`#18 a4 report.js`, …). "replayed" in sync output is unclear.
6. **No review step (2/5).** a4's wrong guess at the Plan shape (#8) was fixed in parallel by
   three agents (#13, #15, #18), which left redundant code and caused the one real conflict.
   Ideas: a `hs propose` that shares a workspace for review before landing, or feed mentions
   (`watch --mentions a3`).
7. **Small things:**
   - `log -f <path>` lists every file in each matching changeset;
   - conflict markers don't name the changeset or author.

**Status after the follow-up:**

- Done: items 1 (rebase wording now names who changed what), 3 (waits start from your synced base, `--timeout`), 4 (`hs watch --stop`, feeds resume) and 5 (`sync`/`land` list incoming changesets).
- Item 6 (review) is addressed by Ship / Show / Ask: owner-default Show, proposals with quorum approvals, and opt-in `/.hsreview` rules (DESIGN.md §10). It has not been tried in an experiment yet.
- Item 2 (finality) is addressed by milestone 4: lands go provisional → settled (the hub has acked) → final (settled and accepted by review); `land --wait-final`, `status`, `log` tags and `watch --for-me` show it (DESIGN.md §11). Not yet tried in an experiment.
- `test/cli.js` covers them through the real `hs` binary and runs by default. Its earlier failures were loopback connectivity, now fixed (DESIGN.md, connectivity notes).

## Experiment 1 findings and their fixes (milestone 2)

See DESIGN.md §9. In short:

- `pull` prefetches the sparse set;
- reads time out instead of stalling;
- stale files are never edits;
- `land -o` waits until a holder has the content, and auto-rebases;
- union merge via `.hsattributes`;
- flip banners;
- `hs watch`, `hs show` and `hs restore`;
- `seed --admit` and `scripts/team.sh`;
- the `docs/AGENTS.md` playbook.

One of these was found while building the fixes rather than by the agents. `land -o` used to
exit before the hub mirror had downloaded the land's content, which left it only on the
author's machine. That is likely the root cause of many of experiment 1's stalls.
