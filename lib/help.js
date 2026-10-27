// Long help for every command (what `hs <cmd> --help` and `hs --menu` show beyond the one-line
// summary) and longer notes for the flags that need one (paparam's hint(): `hs --menu` shows it
// on F1). Kept here so lib/cli.js stays about behavior; createCli applies it (applyHelp), and
// test/help.js checks every visible command has a description.

// keyed by the command's path below `hs` ('ws new'); a command that already has a
// description() in lib/cli.js keeps it
const DESCRIPTIONS = {
  status: [
    'Start here when you come back to a worktree. It lists edits on disk, work committed but not',
    'landed, your lands that are not final yet, and reviews waiting for you, and warns when the',
    'hub is not settling or your last land was undone. Untracked files your .gitignore and',
    '.hsignore rules match never show up or land; --ignored lists them.',
    '',
    'Example: hs status --ignored'
  ],
  diff: [
    'Shows exactly what `hs land` would send: your edits on disk plus anything committed in this',
    'workspace, against main as of your last sync.',
    '',
    'Example: hs diff --stat'
  ],
  ui: [
    'A lazygit-style terminal UI for people: Status, the files `land` would send, the log,',
    'Review (what waits on you, and your open asks) and Tasks (the board) on the left; the',
    'selected diff, changeset, ask or task on the right. c lands (asks for a message), A asks for',
    'review instead (pick reviewers from a list of teammates), p syncs, d discards a file, e',
    'edits it; in Review, a approves, x asks for changes, m comments; in Tasks, n files a task,',
    's starts it, S stops, D marks it done, X drops it. ? lists every key. Its actions run the',
    'same commands you would type. Editors can host it: lazyscion opens it in Neovim.',
    '',
    'Example: hs ui'
  ],
  sync: [
    "Pulls main and replays your unlanded work on top of it. Teammates' changes to other files",
    'apply directly; overlapping text edits are merged three ways, and real conflicts are left',
    'with <<<<<<< markers. Also restores (and lands again) a land of yours that was undone, and',
    'lists open tasks and who leads them.',
    '',
    'Example: hs sync'
  ],
  'wait-final': [
    'Blocks until a land is final: settled by the hub and accepted by any review it needs. While',
    'it waits it says every 30 s whether the hub can be reached. If not, you can stop waiting:',
    'the land settles by itself once someone reaches the hub.',
    '',
    'Example: hs wait-final 27 --timeout 300'
  ],
  agents: [
    'Prints how an AI agent should work with hs, for this version: a short brief, or the full',
    'playbook with --full. --write saves the brief as AGENTS.md, which agent tools read as',
    'instructions.',
    '',
    'Example: hs agents --write'
  ],
  log: [
    'Lists landed changesets, newest first: number, author, state (provisional, settled, final),',
    'message and files. Give a path to see only the changesets that touched it.',
    '',
    'Example: hs log src/pricing.js --oneline'
  ],
  show: [
    'Shows one changeset or ask in full: message, author, state, reviews and the unified',
    'diff. Name a changeset by its number (27): shells read a word starting with # as a',
    'comment, so #27 needs quotes.',
    '',
    'Example: hs show 27 --stat'
  ],
  watch: [
    "Without --count, a feed: it streams teammates' lands, reviews and settlement until you stop",
    'it, and keeps a copy of everything landed so teammates can sync from it while the hub is',
    "down. With --count, a wait: it blocks until that many changesets match, so you don't poll.",
    '',
    'Examples: hs watch --json >> .hs/feed.jsonl &',
    '          hs watch --path /src/model.js --count 1 --timeout 600 --sync'
  ],
  task: [
    'Tasks are how a team decides who builds what. File one with `task new`; whoever runs',
    '`task start` first leads it, and every teammate sees that at once, even with the hub down,',
    'so nobody builds it twice. `hs task` alone lists the board.',
    '',
    'Example: hs task'
  ],
  'task list': [
    'The board: open tasks (change requests, subtasks, ideas) with who leads each one, who else',
    'is on it, and anyone gone quiet on one. hs sync prints the open tasks too.',
    '',
    'Example: hs task list --all'
  ],
  'task new': [
    'Files a task for the team to start. --idea files a suggestion instead, which a person (or',
    'teammate) approves before anyone builds it, when /.hsreview says ideas need approval.',
    '',
    'Examples: hs task new "Price per flight minute" --from CHANGE-REQUEST.md',
    '          hs task new --idea "Cache distances between stops" --paths src/geo.js'
  ],
  'task split': [
    "Breaks a task into a subtask a teammate can start. Only the task's lead (or whoever filed",
    'it) splits it, so the pieces are handed out once.',
    '',
    'Example: hs task split T1a2b3c "Flight minutes per stop"'
  ],
  'task start': [
    "Says you're building a task. It waits about 1.5 s for anyone starting it at the same",
    'moment, then says who leads: whoever started first (exit 2 if that is not you). Starting',
    'never blocks anyone; it tells everyone who to leave it to.',
    '',
    'Example: hs task start T1a2b3c --if-free'
  ],
  'task stop': [
    'Steps away from a task. Anyone else on it keeps it; otherwise it is open again.',
    '',
    'Example: hs task stop T1a2b3c'
  ],
  'task done': [
    'Marks a task done without landing anything (a task whose subtasks all landed, say). A land',
    'usually does it instead: hs land --done closes the task it links itself to.',
    '',
    'Example: hs task done T1a2b3c'
  ],
  'task drop': [
    'Abandons a task you filed, so nobody builds it. Only whoever filed it can drop it.',
    '',
    'Example: hs task drop T1a2b3c'
  ],
  review: [
    'Reviews are how changes get a second pair of eyes. There are three ways in:',
    '  Ship: hs land, and nobody needs to look.',
    '  Show: hs land --reviewers a4 lands now; a4 reviews after (hs review approve 27).',
    '  Ask:  hs review ask -r ann asks first (A5); ann approves (hs review approve A5); you land.',
    'Tasks that /.hsreview gates are approved the same way (hs review approve T1a2b3c).',
    '`hs review` alone shows what waits on you.',
    '',
    'Example: hs review'
  ],
  'review inbox': [
    'What waits on you: tasks you can approve (oldest first), then asks that name you, then',
    'unassigned asks: they name nobody, so anyone may review them, and without the inbox they',
    'would wait unseen. `hs review` alone shows the same.',
    '',
    'Example: hs review inbox --json'
  ],
  'review ask': [
    'Ask before landing: publishes your current changes as an ask (A5) for reviewers to approve.',
    'Asking again makes a new revision, which resets earlier approvals. Once it is approved,',
    'hs land lands it. Reviewers default to the owners and /.hsreview reviewers of the paths.',
    '',
    'Example: hs review ask -m "New pricing contract" -r ann'
  ],
  'review approve': [
    'Approves an ask (A5), a landed change (27, a Show) or a task (T1a2b3c) that /.hsreview',
    'gates. An approval of an ask counts for the revision you saw. --all approves every task',
    'waiting on you, never code.',
    '',
    'Example: hs review approve 27 -m "matches the change request; tests pass"'
  ],
  'review changes': [
    'Submits feedback suggesting changes: the author answers with a new revision (an ask) or a',
    'fix (a land). Start the message with path:line to point at a spot.',
    '',
    'Example: hs review changes A5 -m "src/pricing.js:40 round half up, not down"'
  ],
  'review comment': [
    'Comments on an ask, a landed change or a task without approving or asking for changes.',
    '',
    'Example: hs review comment 27 -m "nice; we could cache this later"'
  ],
  'review list': [
    'Every open ask: those waiting for your review first, then yours, then the rest.',
    '',
    'Example: hs review list --all'
  ],
  ls: [
    'Lists files on main (or your workspace with --ws) without writing anything to disk. Reads',
    'are lazy: only the blocks needed are fetched.',
    '',
    'Example: hs ls src'
  ],
  cat: [
    'Prints one file from main (or your workspace with --ws) without a checkout.',
    '',
    'Example: hs cat src/pricing.js'
  ],
  export: [
    'Writes main as it was at a changeset into an empty directory, like git archive. Nothing in',
    'your worktree changes.',
    '',
    'Example: hs export ../snapshot --at 40'
  ],
  restore: [
    'Throws away your unlanded changes to the files you name (edits on disk and commits) and',
    "puts back main's version as of your last sync. Use it to drop a change, or to keep a",
    "teammate's version after a conflict.",
    '',
    'Example: hs restore src/pricing.js test/pricing.test.js'
  ],
  commit: [
    'Saves a checkpoint of your edits in this workspace without landing. Optional: land commits',
    'for you.',
    '',
    'Example: hs commit'
  ],
  checkout: [
    'Writes files onto disk. With prefixes it narrows what this worktree materializes (a sparse',
    'checkout); without, it refreshes the current sparse set.',
    '',
    'Example: hs checkout src docs'
  ],
  ws: [
    'Workspaces are private forks of main inside one worktree. Forking costs nothing, and nobody',
    'sees a workspace until you land it.',
    '',
    'Example: hs ws new spike && hs ws switch default'
  ],
  'ws new': [
    'Forks a new workspace from main (in constant time) and switches to it.',
    '',
    'Example: hs ws new pricing-spike'
  ],
  'ws switch': [
    'Switches this worktree to another workspace and writes its files to disk.',
    '',
    'Example: hs ws switch default'
  ],
  'ws list': [
    'Lists the workspaces in this worktree and marks the current one.',
    '',
    'Example: hs ws list'
  ],
  init: [
    'Creates a new repo here (or in dir) and prints its invite. For a team, add --hub: it also',
    'creates the hub, the always-on peer that keeps landed work available and makes lands',
    'final. Run hs seed in the hub directory afterwards.',
    '',
    'Example: hs init --as me --hub ../my-project-hub'
  ],
  clone: [
    'Joins a repo from its invite and checks out main. With --admit and a hub running hs seed',
    '--admit, you get write access by yourself; otherwise the owner runs hs add-writer with the',
    'writer key from hs info.',
    '',
    'Example: hs clone <invite> work --as bob --admit ../admit'
  ],
  'add-writer': [
    'Lets another peer land changes. Get their writer key from hs info in their clone. --as',
    'gives them a handle teammates use for reviews and owners.',
    '',
    'Example: hs add-writer <writer-key> --as bob'
  ],
  'remove-writer': [
    'Takes a writer out: a hub that is gone for good, or a lost key. Their later changes are',
    'ignored, and settlement stops waiting for them. To replace a hub, have the live hub add the',
    'new one first.',
    '',
    'Example: hs remove-writer old-hub'
  ],
  info: [
    "Prints this repo's invite, your writer key (for hs add-writer), main's head and your",
    'workspace.',
    '',
    'Example: hs info'
  ],
  doctor: [
    'Checks connectivity: how many peers you reach, whether a holder serves main, how far lands',
    'are settled and which writers settlement waits for, and whether your files are all',
    'obtainable. Says what to do about anything it finds.',
    '',
    'Example: hs doctor'
  ],
  fetch: [
    'Downloads main and everything your files need, without changing your files. Run it before',
    'going offline.',
    '',
    'Example: hs fetch'
  ],
  push: [
    'Makes sure a holder has everything you landed: after a land made offline, or one whose push',
    'timed out. Lands that were undone are left out (hs sync brings them back).',
    '',
    'Example: hs push'
  ],
  seed: [
    "Runs the team's hub in this worktree: stays online, holds every landed file, settles lands,",
    'and with --admit lets new writers in by themselves. Keep it running; never run it in your',
    'own worktree.',
    '',
    'Example: hs seed --admit ../admit'
  ],
  hubs: [
    'A hub home hosts many repos from one hub process: one directory, one store, one network',
    "node. Each repo still has its own hub key. Make repos with `hubs new` on the hub's",
    'machine and keep `hubs serve` running there.',
    '',
    'Example: hs hubs new web-app --home ~/hubs'
  ],
  'hubs new': [
    'Creates a repo hubbed by a hub home (one process and store for many repos): the hub, and',
    "the owner's worktree in owners/<name>. Prints the invite. Run it on the hub's machine; if",
    '`hs hubs serve` is running, the server makes the repo and starts serving it at once.',
    '',
    'Example: hs hubs new web-app --home ~/hubs --as me'
  ],
  'hubs serve': [
    'Runs the hub of every repo in a hub home from one process: holds every landed file, settles',
    'lands, and admits writers whose keys `hs clone --admit <home>/admit/<name>` drops. Repos',
    'made with `hs hubs new` while it runs are served at once. Keep it running.',
    '',
    'Example: hs hubs serve --home ~/hubs'
  ],
  'hubs list': [
    "Lists a hub home's repos with their invites, main and how far each is settled, and whether",
    'a server is running.',
    '',
    'Example: hs hubs list --home ~/hubs'
  ],
  'hubs adopt': [
    "Moves an existing repo's hub into a hub home by the replacement procedure: the old hub",
    'grants a hub in the home weight 2, the home copies everything the old hub held, then',
    'removes it. Teammates change nothing. Stop `hs seed` in the old hub first; it is retired.',
    '',
    'Example: hs hubs adopt web-app ../web-app-hub --home ~/hubs'
  ],
  'hubs add-writer': [
    "Adds a writer to one of a home's repos, as its hub. With --indexer it adds the repo's next",
    'hub: how a repo moves out of a home (then `hs hubs remove`).',
    '',
    'Example: hs hubs add-writer web-app <key> --as hub3 --indexer'
  ],
  'hubs remove': [
    'Stops hubbing a repo in this home. Its hub here steps down first, so a hub elsewhere',
    "settles alone. If this home is the repo's only hub it refuses, unless --force: the repo",
    "then settles on every writer's acks. Needs `hs hubs serve` running.",
    '',
    'Example: hs hubs remove web-app'
  ],
  'blind-peer': [
    'Adds a blind peer: a server that keeps this repo available but stores it encrypted and',
    'cannot read it.',
    '',
    'Example: hs blind-peer <public-key>'
  ],
  'import-git': [
    "Replays a git branch's first-parent history onto main, one changeset per commit.",
    '',
    'Example: hs import-git ../old-repo --branch main'
  ]
}

// keyed by 'command --flag' (the flag's name as paparam stores it: camelCase, no dashes)
const HINTS = {
  'land check': [
    'Runs the command (usually your test suite) on main plus your changes before landing, and',
    'lands only if it passes. If main moves meanwhile, it checks again on the new main.'
  ],
  'land done': [
    'Closes the task this land links itself to (one you lead). Without it, the land counts as',
    'a piece of the task and the task stays open.'
  ],
  'land offline': [
    'Lands on this machine only. Teammates see it after your next online command, and it can',
    'still be undone if someone else landed first.'
  ],
  'land waitFinal': [
    'Waits until the land is final, review included, and exits 2 if it is not by --timeout.'
  ],
  'land split': [
    'When some files need approval (/.hsreview), land the rest now and ask for review of the',
    'protected ones (an ask). --no-split lands nothing instead.'
  ],
  'task start ifFree': [
    'Starts the task only if nobody else leads it; otherwise steps away again at once, so',
    'nothing is left behind.'
  ],
  'task start take': [
    'Takes over a task from a teammate who has gone quiet on it. Everyone sees the takeover.'
  ],
  'task start with': [
    'Starts it together with a teammate: you are co-leads and either can close it.'
  ],
  'task new idea': [
    'A suggestion: a task of kind idea. If /.hsreview says ideas need approval, it waits in',
    "reviewers' hs review before anyone builds it."
  ],
  'watch count': [
    'Turns the feed into a wait: exits after this many matching changesets (exit 2 on',
    '--timeout). Counts from your last sync, so a change that already landed returns at once.'
  ],
  'watch sync': ['After a wait ends, syncs what arrived into your files.'],
  'watch json': ['One JSON object per line, for scripts and agents to read.'],
  'clone admit': [
    "Drops this peer's key into the hub's --admit directory, so a hub running hs seed --admit",
    'lets you write without the owner running hs add-writer.'
  ],
  'clone sparse': ['Only fetch and write files under this prefix. Repeat it for more prefixes.'],
  'init hub': [
    "Also creates the team's hub here: the indexer that settles lands. Run hs seed in it and",
    'keep it online.'
  ],
  'init encrypt': [
    'Encrypts all repo data at rest. The invite then carries the key: anyone with it can read',
    'the repo.'
  ],
  'seed admit': [
    'Admits writers whose keys appear in this directory (hs clone --admit puts them there).'
  ],
  'add-writer indexer': [
    'Makes the writer an indexer: lands settle only once every indexer has seen them. Only a',
    'hub should be one, and only a live hub can add one that settles alone.'
  ]
}

// Related commands together, in the order people need them (`hs --help` lists them this way;
// the same shape bare-tui-paparam's menu takes for its groups). Paths name subcommands
// ('ws new'). A command a surface hides is left out, and so is a group left empty.
const GROUPS = [
  {
    title: 'Your work',
    description: 'The everyday loop: see what you changed, bring main in, land.',
    help: [
      'Edit files, then `hs land`: it commits, rebases onto main and lands in one step. `status`',
      'and `diff` show what would go; `sync` brings teammates’ work in; `restore` drops a change.',
      '`ui` does all of this in a lazygit-style terminal UI.'
    ],
    commands: ['status', 'diff', 'sync', 'land', 'restore', 'commit', 'ui']
  },
  {
    title: 'Follow the team',
    description:
      'Teammates’ lands as they happen, waiting for one, and waiting for yours to be final.',
    help: [
      'Keep `hs watch --json` running in the background instead of polling. `watch --path …',
      '--count 1` waits for a teammate’s file; `wait-final` waits until your land is final.'
    ],
    commands: ['watch', 'wait-final']
  },
  {
    title: 'Tasks: who builds what',
    description: 'File work, start it so two teammates don’t build the same thing, finish it.',
    help: [
      'Start a task before building it: whoever starts first leads, and every peer agrees, even',
      'with the hub down. `hs task` shows the board; `task split` hands out subtasks.'
    ],
    commands: [
      'task list',
      'task new',
      'task split',
      'task start',
      'task stop',
      'task done',
      'task drop'
    ]
  },
  {
    title: 'Review: ship, show or ask',
    description:
      'Ask before landing, review teammates’ work, approve tasks, see what waits on you.',
    help: [
      'Ship: `hs land`. Show: `hs land --reviewers a4`, reviewed after. Ask: `hs review ask`,',
      'approved before you land. `review approve`, `changes` and `comment` answer any of them,',
      'and approve tasks /.hsreview gates; `hs review` alone shows what waits on you.'
    ],
    commands: [
      'review inbox',
      'review ask',
      'review approve',
      'review changes',
      'review comment',
      'review list'
    ]
  },
  {
    title: 'History and files',
    description: 'Main and its history, read without touching your files.',
    help: [
      'Changesets are numbered (#27); name them by number (`hs show 27`). `ls` and `cat` read',
      'main lazily, fetching only what they show; `export` writes a snapshot elsewhere.'
    ],
    commands: ['log', 'show', 'ls', 'cat', 'export']
  },
  {
    title: 'Workspaces and checkout',
    description: 'Private forks of main inside one worktree, and which files are on disk.',
    help: [
      'A workspace forks main in constant time and stays private until you land it. `checkout`',
      'narrows the files this worktree writes to disk (a sparse checkout).'
    ],
    commands: ['ws new', 'ws switch', 'ws list', 'checkout']
  },
  {
    title: 'Set up a team',
    description: 'Create a repo and its hub, join one, and manage who can write.',
    help: [
      'The owner runs `hs init --hub <dir>` and `hs seed` in the hub. Each teammate runs',
      '`hs clone <invite>`; `add-writer` lets them land. `import-git` starts from a git history.'
    ],
    commands: ['init', 'clone', 'add-writer', 'remove-writer', 'info', 'import-git']
  },
  {
    title: 'Hub and network',
    description: 'Keep landed work available, move data, and check connectivity.',
    help: [
      'The hub (`hs seed`) holds everything landed and makes lands final; `hs hubs` hosts many',
      "repos' hubs from one process. `doctor` explains what is wrong when something is; `fetch`",
      'and `push` move data before going offline or after.'
    ],
    commands: [
      'seed',
      'hubs new',
      'hubs serve',
      'hubs list',
      'hubs adopt',
      'hubs add-writer',
      'hubs remove',
      'doctor',
      'fetch',
      'push',
      'blind-peer'
    ]
  },
  {
    title: 'For AI agents',
    description: 'How an agent should work with hs, bundled with this version.',
    help: ['`hs agents --write` saves the brief as AGENTS.md, which agent tools read.'],
    commands: ['agents']
  }
]

const text = (v) => (Array.isArray(v) ? v.join('\n') : v)

// the visible command at a path below `cmd`, or null
function commandAt(cmd, path) {
  let c = cmd
  for (const name of path.split(' ')) {
    c = c._definedCommands.get(name)
    if (!c || c.hidden) return null
  }
  return c
}

// `hs --help`: paparam's usage, with the command list grouped (GROUPS). Subcommands keep
// paparam's own help
function applyGroups(root) {
  const usage = root.usage
  root.usage = function (sub, ...args) {
    if (sub) return usage.call(this, sub, ...args)
    const commands = this._definedCommands
    const oneliner = this._oneliner(false) // with [command], before the list is hidden
    this._definedCommands = new Map() // paparam lists them flat: list nothing, then the groups
    let s = usage.call(this).trimEnd()
    this._definedCommands = commands
    s = oneliner + s.slice(s.indexOf('\n'))
    const rows = []
    for (const g of GROUPS) {
      const listed = g.commands.map((p) => [p, commandAt(this, p)]).filter(([, c]) => c)
      if (!listed.length) continue
      rows.push(null, [g.title, ''], ['  ' + g.description, ''])
      for (const [p, c] of listed) rows.push(['    ' + p, c.summary || ''])
    }
    const width = Math.max(...rows.filter((r) => r && r[1]).map((r) => r[0].length))
    for (const r of rows) s += '\n' + (r ? (r[0].padEnd(width) + '   ' + r[1]).trimEnd() : '')
    s +=
      '\n\n`hs <command> --help` for details and examples; `hs --menu` to explore them in a form.'
    return s
  }
  return root
}

// apply the long help to a command tree built by createCli (and, at the root, the groups)
function applyHelp(cmd, path = []) {
  if (!path.length) applyGroups(cmd)
  const key = path.join(' ')
  if (key && DESCRIPTIONS[key] && !cmd.description) cmd.description = text(DESCRIPTIONS[key])
  for (const [name, f] of cmd._definedFlags || new Map()) {
    if (name !== f.name) continue // aliases point at the same flag
    const hint = HINTS[key + ' ' + f.name]
    if (hint && typeof f.hint === 'function') f.hint(text(hint))
  }
  for (const [name, sub] of cmd._definedCommands || new Map()) applyHelp(sub, path.concat(name))
  return cmd
}

// the menu's F1 help per field: every flag's description and hint, by flag name. A name
// several commands share with different texts gets each, labeled by command
function fieldHelp(root) {
  const byName = new Map()
  const visit = (cmd, path) => {
    for (const [name, f] of cmd._definedFlags || new Map()) {
      if (name !== f.name || f.hidden || f.name === 'help') continue
      const note = [f.description, f.hintText].filter(Boolean).join('\n\n')
      if (!note) continue
      if (!byName.has(f.name)) byName.set(f.name, new Map())
      byName.get(f.name).set(note, path.join(' ') || 'hs')
    }
    for (const arg of cmd._definedArgs || []) {
      if (arg.hidden || !arg.description) continue
      if (!byName.has(arg.name)) byName.set(arg.name, new Map())
      byName.get(arg.name).set(arg.description, path.join(' ') || 'hs')
    }
    for (const [name, sub] of cmd._definedCommands || new Map()) visit(sub, path.concat(name))
  }
  visit(root, [])
  const out = {}
  for (const [name, notes] of byName) {
    out[name] =
      notes.size === 1
        ? [...notes.keys()][0]
        : [...notes].map(([note, cmd]) => `${cmd}: ${note}`).join('\n\n')
  }
  return out
}

module.exports = { applyHelp, fieldHelp, DESCRIPTIONS, HINTS, GROUPS, commandAt }
