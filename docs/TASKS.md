# Tasks: who builds what

Duplicate work is the costliest mistake in a team of agents: everyone reads the same change
request in the same few seconds, and three of them build it. Tasks stop that. A task is a
piece of work; whoever **starts** it first **leads** it, and every teammate knows within a
second or two, even with the hub down.

Starting a task is information, never a lock: nothing refuses to run because of a task.

## The board

```sh
hs task              # open tasks, who leads each, who else is on it, who has gone quiet
hs task list --all   # with done and dropped ones
```

`hs sync` lists the open tasks and their leads too, and `hs watch` streams starts as they
happen.

## Filing a task

```sh
hs task new "Price per flight minute" --from CHANGE-REQUEST.md
hs task new "Cache distances between stops" --paths src/geo.js --kind fix
hs task new "CR-2: invoices" --lead a3          # a3 leads once they start it
hs task split T1a2b3c "Flight minutes per stop" --paths src/scheduler.js,test/scheduler.test.js \
  --spec "flightMinutes(plan, day) -> { id: minutes }; unrounded"   # a subtask a teammate can start
hs task drop T1a2b3c                             # nobody should build it
```

- **Ids** look like `T1a2b3c`. They come from the task's content, so a task can be named and
  started before its record reaches everyone.
- **`--kind`** is `implement`, `fix`, `contract`, `refactor` or `idea`; `/.hsreview` rules can
  key on it (see Approvals). **`--paths`** says what it will likely touch.
- **`--idea`** files a suggestion: a task of kind `idea`, which teammates or a person approve
  when `/.hsreview` says ideas need approval.
- **`--spec`** (or `--spec-file`, on `task new` and `task split`) says what to build, in at
  most 4000 bytes: whoever starts the task sees it, and `hs task show` keeps it. Put a
  longer spec in NOTES.md and say so in this one. `--paths` takes several paths: repeat it,
  separate them with commas, or (on `split`) list them after the title.
- **Splitting** is the lead's (or the author's), so the pieces are handed out once. When the
  last subtask lands, the feed says so (`parts-done`); the parent closes when its lead says so.
- **Dropping** is for whoever filed it.

## Starting one

```sh
hs task start T1a2b3c            # waits its turn (up to ~4 s), then ~1.5 s for a tie
hs task start T1a2b3c --if-free  # start it only if nobody leads it; otherwise step away at once
hs task start --new "Cache the distance matrix"   # file it and start it
```

**A fair start.** Before claiming, `task start` waits a share of a ~4 s window that depends on
the distance between your key and the task id (`HS_CLAIM_BACKOFF_MS` sets the window). When
teammates start the same task at once, the closest goes first and the others see its start and
stay off, with no claim of their own to take back. Each task orders writers differently, so no
one always goes first. A task that names you as lead, one you file with `--new`, and `--take`
start at once. If the task already has a lead, `task start` makes no claim at all.

It ends with a verdict:

- **`you lead T1a2b3c`** (exit 0): build it.
- **`a2 leads T1a2b3c ... you're not on it`** (exit 2; with `--if-free`, exit 0): don't build
  it too. Take a
  subtask, ask the lead for a piece, or review their land when it comes.
- **`!! nobody heard you start it`**: no peers were online, so you lead only on this machine.
  Start it again once you're online, before building.

**Who leads** is decided by the starts themselves: the earliest signed start time, then the
smaller writer key. Every peer computes the same lead from the same starts, whatever order
they arrive in, so a lead changes only if an earlier start turns up (from a teammate who was
cut off, say).

Each writer leads at most 3 tasks at once; `hs task stop` one to start another.

Teammates can share a task: `hs task start T1a2b3c --with a2` makes you co-leads, and
`--note "doing the scheduler side"` says what you're on.

## Staying on it, and stepping away

- A start lapses 20 minutes after its last renewal. `hs land`, `hs sync` and a running
  `hs watch` feed renew it, so working keeps it alive.
- A lapsed start shows on the board as gone quiet. `hs task start T1a2b3c --take` takes the
  task over, visibly.
- `hs task stop T1a2b3c` steps away. Anyone else on it keeps it; otherwise it's open again.

## Finishing

- **A land links itself to the task you lead.** `hs land --done` closes it with that land.
- **`hs task done T1a2b3c`** closes one without a land (all its subtasks landed, say).
- **`hs land --task T1a2b3c`** names the task a land completes, and **`--under T1a2b3c`** adds
  a land to an approved task without closing it.

A task closes as soon as the land that finishes it is on main, provisional or not. If that land
is later undone, the task opens again.

## With the hub down

Starts travel two ways: as signed signals over the connections peers already have (to
whoever is reachable, in milliseconds), and as records in main (for anyone who wasn't online,
or clones tomorrow). So starting a task works through an outage, between teammates whose
feeds are up. Two agents who start the same task while they can't see each other each lead on
their own side; when they meet, the earlier start leads everywhere, and the other is told.

## Approvals

Some work needs a person's yes. `/.hsreview` decides which, never the agent:

```
# /.hsreview
/src/billing/**          approvals=1 reviewers=@humans
task kind=contract       approvals=1 reviewers=@humans
task kind=idea           approvals=1 reviewers=ryan
```

- **People** are writers added with `hs add-writer <key> --as ann --human` (team owner only).
  `@humans` names all of them.
- **A gated task can be started at once.** Only lands into the paths a rule protects wait for
  the approval, so an agent can build and test while it's on its way. `hs task` shows
  `needs 1 approval (0/1, from ann)`.
- **Approving:** `hs review` lists what waits on you; `hs review approve T1a2b3c`, or
  `hs review approve --all` for every task waiting on you. `changes` and `comment` work on
  tasks too.
- **Approve the plan, not each diff.** Once a task is approved, its author's or lead's lands
  into the paths it names go through without a review each.
- **An approval is of what the person saw:** the task's title, kind, paths and lead. The
  author's own approval never counts.
- **Creating a task nobody could approve is refused**, with the fix.

Reviews of changes (Ship, Show, Ask) are in [AGENTS.md](AGENTS.md).

## The commands

| command                                                                         | what                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------- |
| `hs task`, `hs task list [--all]`                                               | the board                                     |
| `hs task show <task>`                                                           | one task: spec, paths, leads, subtasks        |
| `hs task new [title] [--from f] [--kind k] [--idea] [--paths p] [--lead h]`     | file a task                                   |
| `hs task split <task> <title> [--paths p...] [--spec text]`                     | a subtask (the lead's or author's)            |
| `hs task start [task] [--new title] [--if-free] [--with h] [--note t] [--take]` | start it: the first to start leads            |
| `hs task stop <task>`                                                           | step away                                     |
| `hs task done <task>`                                                           | close it without a land                       |
| `hs task drop <task>`                                                           | abandon a task you filed                      |
| `hs land --done`, `--task <id>`, `--under <id>`                                 | close, complete, or add to a task with a land |
| `hs review approve <task>`, `hs review approve --all`                           | approve gated tasks                           |
