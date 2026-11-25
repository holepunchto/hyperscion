// `hs --menu`: the menu is built from hs's real command tree, and what it assembles is the
// command a person would type (driven headlessly, as bare-tui-paparam's own tests do)
const test = require('brittle')
const { KeyMsg } = require('bare-tui')
const { buildMenuApp, runnableCommands, introspect, evaluateArgv } = require('bare-tui-paparam')
const createCli = require('../lib/cli')
const menu = require('../lib/menu')
const { fieldHelp } = require('../lib/help')

const enter = () =>
  new KeyMsg({ name: 'enter', sequence: '\r', ctrl: false, meta: false, shift: false })

test('menu: lists every visible command, not the internal ones', (t) => {
  const labels = runnableCommands(introspect(createCli()).catalog).map((c) => c.label)
  for (const c of ['land', 'sync', 'task start', 'watch', 'agents', 'ws new', 'init', 'seed']) {
    t.ok(labels.includes(c), c)
  }
  t.absent(labels.includes('keepalive'), 'keepalive is the feed’s, not a person’s')
})

test('menu: `hs <cmd> --menu` opens that command', (t) => {
  const cli = createCli()
  t.alike(menu.target(cli, ['--menu']).path, [], 'the whole menu')
  t.alike(menu.target(cli, ['land', '--menu']).path, ['land'])
  t.alike(menu.target(cli, ['ws', 'new', '--menu']).path, ['ws', 'new'])
  t.is(menu.isMenu(['sync']), false)
})

test('menu: a filled land form becomes a land command hs accepts', async (t) => {
  const cli = createCli()
  const app = buildMenuApp(cli, { toolName: 'hs', fieldHelp: fieldHelp(cli) })
  app.update({ type: 'resize', width: 90, height: 30 })
  const items = runnableCommands(introspect(cli).catalog)
  app.menu.selected = items.findIndex((c) => c.label === 'land')
  app.update(enter())
  t.is(app.state, 'forming', 'land opens as a form')
  const [, evaluate] = app.update({
    type: 'form.submit',
    values: { message: 'price per flight minute', check: 'npm test' }
  })
  app.update(await evaluate())
  t.is(app.state, 'confirming', app.formError || 'paparam accepts the assembled command')
  app.update({ type: 'form.submit', values: { choice: app._confirmYes } })
  const argv = app.confirmed.argv
  t.is(argv[0], 'land')
  t.ok(argv.includes('price per flight minute') && argv.includes('npm test'), argv.join(' '))
  const parsed = await evaluateArgv(cli, argv)
  t.absent(parsed.error, 'runs as typed: ' + (parsed.error || ''))
})

// the field definitions a command's form is built from (bare-tui-form's, read as its tests do)
function formFields(cli, label, root) {
  const app = buildMenuApp(cli, { toolName: 'hs', uiSchema: menu.uiSchema(root) })
  app.update({ type: 'resize', width: 90, height: 30 })
  app.menu.selected = runnableCommands(introspect(cli).catalog).findIndex((c) => c.label === label)
  app.update(enter())
  const out = {}
  for (const d of app.form._defs) out[d.key || d.name] = d
  return out
}

test('menu: path fields open the file or folder picker', (t) => {
  const cli = createCli()
  const root = '/work/a1'
  const picker = (label, field) => {
    const d = formFields(cli, label, root)[field]
    return d && d.type === 'file' ? d.pick : d && d.type
  }
  t.is(picker('init', 'dir'), 'dir', 'init [dir]')
  t.is(picker('init', 'hub'), 'dir', 'init --hub')
  t.is(picker('clone', 'dir'), 'dir', 'clone [dir]')
  t.is(picker('clone', 'admit'), 'dir', 'clone --admit')
  t.is(picker('clone', 'as'), 'text', 'clone --as is a handle, not a folder')
  t.is(picker('seed', 'admit'), 'dir', 'seed --admit')
  t.is(picker('export', 'dir'), 'dir', 'export <dir>')
  t.is(picker('import-git', 'gitdir'), 'dir', 'import-git <gitdir> is a folder')
  t.is(picker('task new', 'from'), 'file', 'task new --from')
  t.is(picker('cat', 'path'), 'file', 'cat <path>')
  t.is(picker('log', 'path'), 'file', 'log [path]')
  t.is(picker('ls', 'prefix'), 'dir', 'ls [prefix]')
  t.is(formFields(cli, 'cat', root).path.cwd, root, 'repo paths browse from the worktree root')
})

test('menu: a picked file in the worktree becomes a repo path', (t) => {
  const root = '/work/a1'
  t.alike(menu.toRepoPaths(['cat', '/work/a1/src/model.js'], root), ['cat', '/src/model.js'])
  t.alike(menu.toRepoPaths(['ls', '/work/a1'], root), ['ls', '/'])
  t.alike(menu.toRepoPaths(['log', '/work/a1/src', '-n', '5'], root), ['log', '/src', '-n', '5'])
  t.alike(menu.toRepoPaths(['cat', 'src/x.js'], root), ['cat', 'src/x.js'], 'typed paths stay')
  t.alike(menu.toRepoPaths(['cat', '/elsewhere/x.js'], root), ['cat', '/elsewhere/x.js'])
  t.alike(
    menu.toRepoPaths(['export', '/work/a1/out'], root),
    ['export', '/work/a1/out'],
    'a folder on disk stays'
  )
  t.alike(menu.toRepoPaths(['land', '-m', 'cat'], root), ['land', '-m', 'cat'])
})

// the menu is sectioned like `hs --help` (lib/help.js GROUPS): same titles, same order,
// nothing left in bare-tui-paparam's trailing "Other"
test('menu: grouped like hs --help', (t) => {
  const { GROUPS } = require('../lib/help')
  const cli = createCli()
  const app = buildMenuApp(cli, { toolName: 'hs', groups: menu.groups(cli) })
  app.update({ type: 'resize', width: 100, height: 60 })
  const titles = app.menu.groups.map((g) => g.title)
  t.alike(
    titles,
    GROUPS.map((g) => g.title),
    'the help groups, in order'
  )
  t.absent(titles.includes('Other'), 'every command is in a group')
  t.ok(
    app.menu.groups.every((g) => g.help),
    'each group has help for F1 on its header'
  )

  // choosing a command inside a group still opens its form
  app.menu._select(app.menu.rows.findIndex((r) => r.type === 'item' && r.item.label === 'land'))
  app.update(enter())
  t.is(app.state, 'forming')
  t.is(app._pending.item.label, 'land')
})

test('menu: a surface drops the groups it has no commands for', (t) => {
  const { env } = require('bare-process')
  const was = env.HS_SURFACE
  env.HS_SURFACE = 'plain'
  try {
    const titles = menu.groups(createCli()).map((g) => g.title)
    t.absent(titles.includes('Decide who builds what'), 'no claims on the task-board surface')
    t.ok(titles.includes('Your work'))
  } finally {
    if (was === undefined) delete env.HS_SURFACE
    else env.HS_SURFACE = was
  }
})
