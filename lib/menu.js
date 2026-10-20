// `hs --menu`: a way for people to explore hs. Pick a command from a filterable list, fill a
// form built from its flags and arguments (F1 shows the help for the focused field), confirm,
// and it runs exactly as the typed command would. `hs <cmd> --menu` opens that command's form
// directly. bare-tui-paparam is loaded only here, so ordinary calls don't pay for it.
const path = require('bare-path')
const process = require('bare-process')

// path fields get the file or folder picker (space on an empty field opens it). Keyed by field
// name across commands, as bare-tui-paparam's uiSchema is. '' undoes a wrong automatic pick
// (`clone --as` is a handle; its description mentions the directory name)
const PICKERS = {
  dir: 'directory', // init, clone, export: a folder on this machine
  hub: 'directory', // init --hub
  admit: 'directory', // clone --admit, seed --admit
  gitdir: 'directory', // import-git
  from: 'file', // item --from: a file on this machine
  path: 'file', // cat, log: a file in the repo
  prefix: 'directory', // ls: a folder in the repo
  as: ''
}

// positional arguments that name a path in the repo, not on this machine: the picker starts
// at the worktree root and what it returns (an absolute path) becomes a repo path
const REPO_ARGS = { cat: 'path', log: 'path', ls: 'prefix' }

function isMenu(argv) {
  return argv.includes('--menu')
}

// the command `hs a b --menu` names (and its path), or the root
function target(cli, argv) {
  const at = []
  let cmd = cli
  for (const word of argv) {
    if (word === '--menu' || word.startsWith('-')) break
    const sub = cmd._definedCommands && cmd._definedCommands.get(word)
    if (!sub || sub.hidden) break
    cmd = sub
    at.push(word)
  }
  return { cmd, path: at }
}

function uiSchema(root) {
  const ui = {}
  for (const [name, widget] of Object.entries(PICKERS)) ui[name] = { 'ui:widget': widget }
  if (root) {
    for (const name of new Set(Object.values(REPO_ARGS))) ui[name]['ui:options'] = { cwd: root }
  }
  return ui
}

// a picked absolute path inside the worktree, as the repo path hs expects (/src/model.js)
function repoPath(token, root) {
  if (!root || !path.isAbsolute(token)) return token
  const rel = path.relative(root, token)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return token
  return '/' + rel.split(path.sep).join('/')
}

// argv as typed after `hs`: for cat, log and ls the positional right after the command's name
// is a repo path (the menu puts positionals before flags)
function toRepoPaths(argv, root) {
  const out = argv.slice()
  if (REPO_ARGS[out[0]] && out.length > 1 && !out[1].startsWith('-')) {
    out[1] = repoPath(out[1], root)
  }
  return out
}

// the menu's sections: the groups `hs --help` lists (lib/help.js GROUPS), keeping only
// commands this surface shows; help is markdown, shown by F1 on a group's header
function groups(cli) {
  const { GROUPS, commandAt } = require('./help')
  return GROUPS.map((g) => ({
    title: g.title,
    description: g.description,
    help: Array.isArray(g.help) ? g.help.join('\n') : g.help,
    commands: g.commands.filter((p) => commandAt(cli, p))
  })).filter((g) => g.commands.length)
}

// resolves the argv to run (as typed after `hs`), or null when the person quit
async function pick(cli, argv) {
  const { runMenu } = require('bare-tui-paparam')
  const { fieldHelp } = require('./help')
  const Context = require('./context')
  const root = await Context.find(process.cwd()).catch(() => null)
  const { cmd, path: at } = target(cli, argv)
  let chosen = null
  await runMenu(cmd, {
    toolName: ['hs', ...at].join(' '),
    fieldHelp: fieldHelp(cli),
    uiSchema: uiSchema(root),
    // the whole menu only: `hs ws --menu` lists ws's own commands, which these paths don't name
    groups: at.length ? undefined : groups(cli),
    onComplete: (result, ctx) => {
      chosen = toRepoPaths([...at, ...ctx.argv], root)
    }
  })
  return chosen
}

module.exports = { isMenu, pick, target, uiSchema, toRepoPaths, groups, PICKERS }
