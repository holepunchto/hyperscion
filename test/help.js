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
