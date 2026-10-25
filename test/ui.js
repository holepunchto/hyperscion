// `hs ui`: its reads (lib/ui/backend.js), the worker threads it runs hs on (lib/ui/client.js),
// and the model's keys and flow (lib/ui/app.js) with a fake client
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const tmp = require('test-tmp')
const { KeyMsg, style } = require('bare-tui')
const { run } = require('./helpers/team')
const Context = require('../lib/context')
const backend = require('../lib/ui/backend')
const Client = require('../lib/ui/client')
const App = require('../lib/ui/app')

const write = (dir, p, s) => fs.writeFileSync(path.join(dir, p), s)

// a solo repo with one land (/a.txt, /b.txt), then an edit, a new file and a deletion
async function worktree(t) {
  const dir = await tmp(t)
  const env = { ...process.env, USER: 'ann' }
  t.is((await run(dir, ['init'], env)).code, 0, 'init')
  write(dir, 'a.txt', 'one\n')
  write(dir, 'b.txt', 'bee\n')
  t.is((await run(dir, ['land', '-m', 'first files'], env)).code, 0, 'land')
  write(dir, 'a.txt', 'one\ntwo\n')
  write(dir, 'c.txt', 'new\n')
  fs.unlinkSync(path.join(dir, 'b.txt'))
  return dir
}

test('ui backend: snapshot, log and show, as data', async (t) => {
  const dir = await worktree(t)

  const snap = await backend.snapshot(dir)
  t.is(snap.workspace, 'default')
  t.is(snap.base, 1)
  t.ok(
    snap.header.some((l) => /^last land: #1 final/.test(l)),
    'the header as status prints it'
  )
  t.alike(
    snap.files.map((f) => `${f.status} ${f.path} ${f.kind}`),
    ['modified /a.txt M', 'deleted /b.txt D', 'added /c.txt A']
  )
  const a = snap.files.find((f) => f.path === '/a.txt')
  t.ok(a.diff.includes('+two'), 'each file carries its own diff')
  t.absent(a.diff.includes('c.txt'), 'and only its own')

  const log = await backend.log(dir)
  t.is(log.length, 1)
  t.is(log[0].seq, 1)
  t.is(log[0].who, 'ann')
  t.is(log[0].message, 'first files')
  t.alike(log[0].files, ['/a.txt', '/b.txt'])

  const shown = await backend.show(dir, { seq: 1 })
  t.ok(/^changeset #1 /.test(shown), 'show renders as hs show does')
  t.ok(shown.includes('+bee'))

  // another command holding the worktree: reads fall back to read-only, as hs status does
  const holder = await Context.open(dir)
  t.teardown(() => holder.close())
  const busy = await backend.snapshot(dir)
  t.is(busy.files.length, 3, 'reads while another command holds the store')
  t.ok(
    busy.header.some((l) => /is using this worktree: showing local data/.test(l)),
    'and says so'
  )
})

test('ui client: reads and runs on worker threads, output captured', async (t) => {
  const dir = await worktree(t)
  const client = new Client({ cwd: dir })
  t.teardown(() => client.close())

  const snap = await client.read('snapshot')
  t.is(snap.files.length, 3, 'the read worker answers')
  await t.exception(client.read('nope'), /unknown op/)

  // runs use the process's cwd, as a typed command does
  const was = process.cwd()
  process.chdir(dir)
  t.teardown(() => process.chdir(was))

  const lines = []
  const status = await client.run(['status'], (l) => lines.push(l))
  t.is(status.code, 0)
  t.ok(lines.includes('  modified  /a.txt'), 'lines come back as messages, not on stdout')

  const land = await client.run(['land', '-m', 'from the ui'])
  t.is(land.code, 0, 'a land on a run worker')
  t.ok(land.lines.some((l) => /^landed #2/.test(l)))

  // the next read sees it (and isn't tripped by anything the land's thread left behind)
  const after = await client.read('snapshot')
  t.is(after.files.length, 0, 'clean after the land')
  t.is((await client.read('log'))[0].message, 'from the ui')

  const bad = await client.run(['nope'])
  t.is(bad.code, 1)
  t.ok(bad.lines[0].startsWith('hs: '), 'errors as bin.mjs reports them')
})

// --- the model, with a fake client ----------------------------------------------------------

const key = (name, mods = {}) =>
  new KeyMsg({ name, sequence: name, ctrl: false, meta: false, shift: false, ...mods })

const SNAP = {
  root: '/w',
  workspace: 'default',
  base: 3,
  header: ['workspace default (base #3)', 'last land: #3 final'],
  files: [
    { path: '/a.txt', status: 'modified', kind: 'M', diff: '--- a/a.txt\n+++ b/a.txt\n+two\n' },
    { path: '/c.txt', status: 'added', kind: 'A', diff: '--- /dev/null\n+++ b/c.txt\n+new\n' }
  ]
}
const LOG = [
  { seq: 3, who: 'ann', state: 'final', message: 'third', files: ['/a.txt'] },
  { seq: 2, who: 'bob', state: 'settled', message: 'second', files: ['/b.txt'] }
]

function fake() {
  const calls = []
  return {
    calls,
    reads: 0,
    read(op, args) {
      this.reads++
      if (op === 'snapshot') return Promise.resolve(SNAP)
      if (op === 'log') return Promise.resolve(LOG)
      if (op === 'show') return Promise.resolve(`changeset #${args.seq}\n+line of ${args.seq}\n`)
      return Promise.reject(new Error('op ' + op))
    },
    run(argv) {
      calls.push(argv)
      return Promise.resolve({ code: 0, lines: ['did ' + argv[0]] })
    }
  }
}

// run the Cmds an update returned, feeding their messages back in; a Cmd still pending after a
// moment (the idle timer) is left alone
async function exec(app, cmd) {
  if (!cmd) return
  if (Array.isArray(cmd)) {
    for (const c of cmd) await exec(app, c)
    return
  }
  const msg = await Promise.race([cmd(), new Promise((resolve) => setTimeout(resolve, 30, null))])
  if (msg) await exec(app, app.update(msg)[1])
}

async function press(app, ...keys) {
  for (const k of keys) await exec(app, app.update(typeof k === 'string' ? key(k) : k)[1])
}

const screen = (app) => style.stripAnsi(app.view())

async function started(opts = {}) {
  const client = fake()
  const app = new App({ client, idleMs: 60_000, ...opts })
  app.update({ type: 'resize', width: 100, height: 20 })
  await exec(app, app.init())
  return { app, client }
}

test('ui model: loads Files and Log, the main panel follows the selection', async (t) => {
  const { app } = await started()
  const s = screen(app)
  t.ok(s.includes('modified  /a.txt') && s.includes('added     /c.txt'), 'files')
  t.ok(s.includes('#3 ann final third') && s.includes('#2 bob settled second'), 'log')
  t.ok(s.includes('+two'), "the first file's diff")

  await press(app, 'j')
  t.ok(screen(app).includes('+new'), 'j: the next file')
  t.absent(screen(app).includes('+two'))

  await press(app, '3')
  t.ok(screen(app).includes('+line of 3'), '3: the log, with the changeset shown')
  await press(app, 'j')
  t.ok(screen(app).includes('+line of 2'), 'j: the next changeset')
})

test('ui model: c lands with a message, then everything refreshes', async (t) => {
  const { app, client } = await started()
  const before = client.reads
  await press(app, 'c')
  t.ok(screen(app).includes('Message for this land'), 'asks for a message')
  await press(app, 'enter')
  t.alike(client.calls, [], 'no land without a message')
  await press(app, 's', 'h', 'i', 'p', 'enter')
  t.alike(client.calls, [['land', '-m', 'ship']])
  t.ok(screen(app).includes('did land'), 'its output shows')
  t.ok(client.reads >= before + 2, 'snapshot and log read again')
  await press(app, key('escape', { meta: true })) // a lone Esc, as the decoder reports it
  t.ok(screen(app).includes('+two'), 'esc closes the output')
})

test('ui model: d asks before discarding; n keeps the file', async (t) => {
  const { app, client } = await started()
  await press(app, 'd', 'n')
  t.alike(client.calls, [], 'n: nothing run')
  await press(app, 'j', 'd')
  t.ok(screen(app).includes('Delete /c.txt?'), 'a new file is deleted, and it says so')
  await press(app, 'y')
  t.alike(client.calls, [['restore', '/c.txt']])
})

test('ui model: p syncs; stale replies are dropped; one action at a time', async (t) => {
  const { app, client } = await started()
  await press(app, 'p')
  t.alike(client.calls, [['sync']])

  app.update({ type: 'snap', gen: app.gen.snap - 1, data: { ...SNAP, files: [] } })
  t.ok(screen(app).includes('/a.txt'), 'an old snapshot does not replace a newer one')

  // a second action while one runs waits its turn: the UI says so and runs nothing
  let release = null
  client.run = (argv) => {
    client.calls.push(argv)
    return new Promise((resolve) => {
      release = () => resolve({ code: 0, lines: [] })
    })
  }
  app.popup = null
  const pending = app.update(key('p'))[1]
  const running = pending()
  app.popup = null
  app.update(key('p'))
  t.is(client.calls.length, 2, 'the second p ran nothing')
  t.ok(screen(app).includes('still running'), 'and says why')
  release()
  await running
})

test('ui model: e edits the selected file through the editor hook', async (t) => {
  const opened = []
  const { app } = await started({ edit: (file) => (opened.push(file), null) })
  await press(app, 'e')
  t.alike(opened, ['/w/a.txt'], 'the absolute path')
})
