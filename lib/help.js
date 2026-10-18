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
    'hub is not settling or your last land was undone.',
    '',
    'Example: hs status'
  ],
  diff: [
    'Shows exactly what `hs land` would send: your edits on disk plus anything committed in this',
    'workspace, against main as of your last sync.',
    '',
    'Example: hs diff --stat'
  ],
  sync: [
    "Pulls main and replays your unlanded work on top of it. Teammates' changes to other files",
    'apply directly; overlapping text edits are merged three ways, and real conflicts are left',
    'with <<<<<<< markers. Also restores (and lands again) a land of yours that was undone, and',
    'lists open work items and who leads them.',
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
    'Shows one changeset or proposal in full: message, author, state, reviews and the unified',
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
  claims: [
    'The board: open items (change requests, parts, ideas) with who leads each one, who else is',
    'on it, and claims that went stale. hs sync prints the open items too.',
    '',
    'Example: hs claims --all'
  ],
  item: [
    'Creates work for the team to claim. new files an item (a change request, a fix, an idea);',
    "part splits an item into a piece a teammate can claim (only the item's lead can split it).",
    '',
    'Examples: hs item new "Price per flight minute" --from CHANGE-REQUEST.md',
    '          hs item part C1a2b3c "Flight minutes per stop"'
  ],
  propose: [
    'Ask before landing: publishes your current changes as a proposal (P5) for reviewers to',
    'approve. Proposing again makes a new revision. Once approved, hs land lands it.',
    '',
    'Example: hs propose -m "New pricing contract" -r ann'
  ],
  review: [
    'Records your review of a proposal (P5), a landed changeset (#27) or an item (C1a2b3c):',
    'approve, ask for changes, or just comment. Start a comment with path:line to point at a',
    'spot.',
    '',
    'Example: hs review 27 approve -m "matches the change request; tests pass"'
  ],
  proposals: [
    'Lists open proposals: those waiting for your review first, then yours, then the rest.',
    '',
    'Example: hs proposals --all'
  ],
  suggest: [
    'Files an idea as an item of kind idea, for teammates (or a person) to approve or claim.',
    '',
    'Example: hs suggest "Cache distances between stops" --paths src/geo.js'
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
    'Closes the item this land links itself to (one you lead). Without it, the land counts as',
    'a piece of the item and the item stays open.'
  ],
  'land offline': [
    'Lands on this machine only. Teammates see it after your next online command, and it can',
    'still be undone if someone else landed first.'
  ],
  'land waitFinal': [
    'Waits until the land is final, review included, and exits 2 if it is not by --timeout.'
  ],
  'land split': [
    'When some files need approval (/.hsreview), land the rest now and propose the protected',
    'ones. --no-split lands nothing instead.'
  ],
  'claim ifFree': [
    'Claims the item only if nobody else leads it; otherwise withdraws your claim at once, so',
    'nothing is left behind.'
  ],
  'claim take': [
    'Takes over an item from a teammate whose claim went stale. Everyone sees the takeover.'
  ],
  'claim with': ['Claims together with a teammate: you are co-leads and either can close it.'],
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

const text = (v) => (Array.isArray(v) ? v.join('\n') : v)

// apply the long help to a command tree built by createCli
function applyHelp(cmd, path = []) {
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

module.exports = { applyHelp, fieldHelp, DESCRIPTIONS, HINTS }
