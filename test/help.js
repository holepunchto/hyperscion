// Every command explains itself (`hs <cmd> --help`, `hs --menu`), and lib/help.js only names
// commands and flags that exist
const test = require('brittle')
const createCli = require('../lib/cli')
const { DESCRIPTIONS, HINTS, fieldHelp } = require('../lib/help')

function walk(cmd, path, visit) {
  visit(cmd, path)
  for (const [name, sub] of cmd._definedCommands) walk(sub, path.concat(name), visit)
}

test('help: every visible command has a summary and a description', (t) => {
  const missing = []
  walk(createCli(), [], (cmd, path) => {
    if (cmd.hidden) return
    if (!cmd.summary || !cmd.description) missing.push(path.join(' ') || 'hs')
    for (const [name, f] of cmd._definedFlags) {
      if (name === f.name && !f.hidden && !f.description) {
        missing.push(`${path.join(' ')} --${name}`)
      }
    }
  })
  t.alike(missing, [], 'nothing without help')
})

test('help: lib/help.js names only real commands and flags', (t) => {
  const commands = new Set()
  const flags = new Set()
  walk(createCli(), [], (cmd, path) => {
    const key = path.join(' ')
    commands.add(key)
    for (const [name, f] of cmd._definedFlags) if (name === f.name) flags.add(key + ' ' + name)
  })
  t.alike(
    Object.keys(DESCRIPTIONS).filter((k) => !commands.has(k)),
    [],
    'descriptions'
  )
  t.alike(
    Object.keys(HINTS).filter((k) => !flags.has(k)),
    [],
    'hints'
  )
})

test('help: the menu gets a note for every flag, with hints', (t) => {
  const notes = fieldHelp(createCli())
  t.ok(/on main plus your changes before landing/.test(notes.check), 'land --check hint')
  t.ok(notes.message && /land/.test(notes.message), 'shared flag names say which command')
})

// shells read a word starting with # as a comment: `hs wait-final #4` runs as `hs wait-final`.
// Whatever hs tells people to type names changesets by their bare number (TO-FIVE #28)
test('help: suggested commands use bare changeset numbers', (t) => {
  const fs = require('bare-fs')
  const path = require('bare-path')
  const root = path.join(__dirname, '..')
  const typed = /hs [a-z-]+(?: [a-z-]+)* '?#\$?\{?[0-9a-zA-Z.]/
  for (const f of [
    'lib/cli.js',
    'lib/help.js',
    'docs/BRIEF.md',
    'docs/AGENTS.md',
    'docs/AGENTS-min.md'
  ]) {
    const bad = fs
      .readFileSync(path.join(root, f), 'utf8')
      .split('\n')
      .filter((l) => typed.test(l) && !/^\s*\/\//.test(l))
    t.alike(bad, [], f)
  }
})

// `hs --help` lists commands by group: every visible command in exactly one, none twice, and
// every group named and described (the shape bare-tui-paparam's menu groups take)
test('help: every command is in exactly one group', (t) => {
  const { GROUPS, commandAt } = require('../lib/help')
  const cli = createCli()
  const leaves = []
  walk(cli, [], (cmd, path) => {
    if (!path.length || cmd.hidden) return
    if (cmd._definedCommands.size === 0 || cmd._definedArgs.length) leaves.push(path.join(' '))
  })
  const grouped = GROUPS.flatMap((g) => g.commands)
  t.alike(
    leaves.filter((p) => !grouped.includes(p)),
    [],
    'no command left out'
  )
  t.alike(
    grouped.filter((p, i) => grouped.indexOf(p) !== i),
    [],
    'none listed twice'
  )
  t.alike(
    grouped.filter((p) => !commandAt(cli, p)),
    [],
    'groups name real commands'
  )
  for (const g of GROUPS) t.ok(g.title && g.description && g.help, g.title)
  const help = cli.help()
  const at = GROUPS.map((g) => help.indexOf('\n' + g.title + '\n'))
  t.ok(
    at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])),
    'hs --help shows the groups in order'
  )
  t.ok(/^hs \[flags\] \[command\]/.test(help), 'usage keeps [command]')
})

test('help: hs with no command prints the grouped help and exits 1, as git does', async (t) => {
  const { run } = require('./helpers/team')
  const tmp = require('test-tmp')
  const { env } = require('bare-process')
  const r = await run(await tmp(t), [], { ...env, HS_SURFACE: '' })
  t.is(r.code, 1, 'no command is a usage mistake')
  t.ok(/\nYour work\n/.test(r.stdout) && /\nSet up a team\n/.test(r.stdout), 'the groups')
  t.is((await run(await tmp(t), ['--help'], { ...env, HS_SURFACE: '' })).code, 0, '--help exits 0')
})
