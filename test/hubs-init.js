// `hs hubs init`: an empty hub home, recorded as this machine's default so `hs hubs` commands
// find it without --home; and `~` in a home path, which fish passes through unexpanded
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const tmp = require('test-tmp')
const { isWindows } = require('which-runtime')
const { run } = require('./helpers/team')

test('hubs init: an empty home, the default from then on', async (t) => {
  const dir = await tmp(t)
  const user = path.join(dir, 'user') // stands in for $HOME and ~/.config
  fs.mkdirSync(path.join(user, 'elsewhere'), { recursive: true })
  const env = {
    ...require('bare-process').env,
    HOME: user,
    USERPROFILE: user, // the home directory on Windows
    XDG_CONFIG_HOME: path.join(user, '.config')
  }
  delete env.HS_HUB_HOME
  const hs = (args, cwd = path.join(user, 'elsewhere')) => run(cwd, args, env)

  const none = await hs(['hubs', 'list'])
  t.is(none.code, 1)
  t.ok(none.stderr.includes('no hub home yet: `hs hubs init`'), none.stderr.trim())

  const made = await hs(['hubs', 'init'])
  t.is(made.code, 0, made.stderr)
  const home = path.join(user, 'hubs')
  t.ok(made.stdout.includes('made a hub home: ' + home), 'defaults to ~/hubs')
  t.ok(made.stdout.includes("this machine's default"))
  t.alike(JSON.parse(fs.readFileSync(path.join(home, 'hubs.json'), 'utf8')), {
    format: 1,
    repos: {}
  })
  t.is(fs.readFileSync(path.join(user, '.config', 'hs', 'hub-home'), 'utf8').trim(), home)

  const again = await hs(['hubs', 'init'])
  t.ok(again.stdout.includes('already a hub home'), 'init twice is fine')

  // found from anywhere, with no --home
  const listed = await hs(['hubs', 'list'])
  t.is(listed.code, 0, listed.stderr)
  t.ok(listed.stdout.startsWith(home + ': not served'), listed.stdout)
  // services are systemd and launchd only (lib/service.js)
  if (!isWindows) {
    const printed = await hs(['hubs', 'service', 'install', '--print'])
    t.is(printed.code, 0, 'an empty home can be a service: ' + printed.stderr)
    // systemd: one ExecStart line; launchd: each argument its own <string> in the plist
    const named =
      printed.stdout.includes('--home ' + home) ||
      printed.stdout.includes('<string>--home</string>\n    <string>' + home + '</string>')
    t.ok(named, 'the service names the home: ' + printed.stdout)
  }

  // ~ as fish leaves it
  const tilde = await run(path.join(user, 'elsewhere'), ['hubs', 'list'], {
    ...env,
    HS_HUB_HOME: '~/hubs'
  })
  t.ok(tilde.stdout.startsWith(home + ': not served'), 'HS_HUB_HOME=~/hubs: ' + tilde.stdout)
  t.absent(fs.existsSync(path.join(user, 'elsewhere', '~')), 'no directory named ~')

  // another home, not the default
  const other = await hs(['hubs', 'init', path.join(user, 'work-hubs'), '--no-default'])
  t.is(other.code, 0, other.stderr)
  t.is(fs.readFileSync(path.join(user, '.config', 'hs', 'hub-home'), 'utf8').trim(), home)

  // a second home without --default keeps the working default (another session's scratch
  // `hubs init` replaced a real hub's default, and its service install then failed)
  const scratch = path.join(user, 'scratch-hubs')
  const side = await hs(['hubs', 'init', scratch])
  t.is(side.code, 0, side.stderr)
  t.ok(side.stdout.includes("this machine's default stays " + home), side.stdout)
  t.is(fs.readFileSync(path.join(user, '.config', 'hs', 'hub-home'), 'utf8').trim(), home)
  const switched = await hs(['hubs', 'init', scratch, '--default'])
  t.ok(switched.stdout.includes("it's this machine's default"), switched.stdout)
  t.is(fs.readFileSync(path.join(user, '.config', 'hs', 'hub-home'), 'utf8').trim(), scratch)

  // the default is gone: say where it was recorded, never recreate it there
  fs.rmSync(scratch, { recursive: true, force: true })
  const gone = await hs(['hubs', 'list'])
  t.is(gone.code, 1)
  t.ok(gone.stderr.includes("this machine's default hub home is " + scratch), gone.stderr)
  t.ok(gone.stderr.includes(path.join(user, '.config', 'hs', 'hub-home')), 'names the file')
  t.absent(fs.existsSync(scratch), 'not recreated')
  // and init puts a working one back
  const back = await hs(['hubs', 'init'])
  t.ok(back.stdout.includes("it's this machine's default"), back.stdout)
  t.is(fs.readFileSync(path.join(user, '.config', 'hs', 'hub-home'), 'utf8').trim(), home)

  // a hubs.json that doesn't parse is an error, never an empty home saved over it (it holds
  // every repo's keys); one from a newer hs is refused too
  const file = path.join(home, 'hubs.json')
  fs.writeFileSync(file, '{ "repos": { "x": ')
  const broken = await hs(['hubs', 'new', 'r9'])
  t.is(broken.code, 1)
  t.ok(broken.stderr.includes('does not parse'), broken.stderr)
  t.is(fs.readFileSync(file, 'utf8'), '{ "repos": { "x": ', 'left as it was')
  fs.writeFileSync(file, JSON.stringify({ format: 99, repos: {} }))
  const newer = await hs(['hubs', 'list'])
  t.ok(newer.stderr.includes('from a newer hs (format 99'), newer.stderr)
})

test('hubs new --dir: an existing folder becomes the worktree, files kept', async (t) => {
  const dir = await tmp(t)
  const env = {
    ...require('bare-process').env,
    HOME: dir,
    USERPROFILE: dir, // the home directory on Windows
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    USER: 'me'
  }
  delete env.HS_HUB_HOME
  const hs = (args, cwd = dir) => run(cwd, args, env)
  t.is((await hs(['hubs', 'init'])).code, 0)

  // a folder with work in it, and a git repo's .git
  const folder = path.join(dir, 'notes')
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'todo.md'), '- ship it\n')
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  const made = await hs(['hubs', 'new', 'notes', '--dir', '~/notes'])
  t.is(made.code, 0, made.stderr)
  t.ok(made.stdout.includes('your worktree ' + folder), made.stdout)
  t.ok(made.stdout.includes("its files aren't on main yet"), 'says the files are not landed')
  t.ok(made.stdout.includes('hs import-git'), 'and that a git checkout can bring its history')
  t.is(fs.readFileSync(path.join(folder, 'todo.md'), 'utf8'), '- ship it\n', 'files untouched')
  t.ok(fs.existsSync(path.join(folder, '.hs', 'config.json')), 'the folder is a worktree')
  t.absent(fs.existsSync(path.join(dir, 'hubs', 'owners', 'notes')), 'nothing in owners/')
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'hubs', 'hubs.json'), 'utf8'))
  t.is(config.repos.notes.worktree, folder)

  const diff = await hs(['diff', '--stat'], folder)
  t.ok(diff.stdout.includes('todo.md'), 'diff shows the files: ' + diff.stdout)
  t.absent(diff.stdout.includes('.git'), 'never .git')
  const landed = await hs(['land', '--offline', '-m', 'first'], folder)
  t.ok(/landed #1/.test(landed.stdout), landed.stdout + landed.stderr)

  const again = await hs(['hubs', 'new', 'notes2', '--dir', folder])
  t.is(again.code, 1)
  t.ok(again.stderr.includes('is already an hs worktree'), again.stderr.trim())
  const inHome = await hs(['hubs', 'new', 'x', '--dir', path.join(dir, 'hubs', 'x')])
  t.is(inHome.code, 1)
  t.ok(inHome.stderr.includes('inside the hub home'), inHome.stderr.trim())
})
