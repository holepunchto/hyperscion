// hs ui's Review panel on a real team: a1 asks a2 for review, a2 sees it in the panel and
// approves it on a worker thread, a1 sees it approved; then a Show (land --reviewers) and a
// request for changes on it
const test = require('brittle')
const process = require('bare-process')
const { team } = require('./helpers/team')
const backend = require('../lib/ui/backend')
const Client = require('../lib/ui/client')

// runs on the worker threads use the process's cwd and env, as typed commands do
function as(t, tm, name) {
  const was = { cwd: process.cwd(), env: { ...process.env } }
  process.chdir(tm.agents[name])
  Object.assign(process.env, tm.envOf(name))
  t.teardown(() => {
    process.chdir(was.cwd)
    for (const k of Object.keys(process.env)) if (!(k in was.env)) delete process.env[k]
    Object.assign(process.env, was.env)
  })
}

test('ui review: ask, see it in Review, approve it; a Show and a request for changes', async (t) => {
  const tm = await team(t, { agents: ['a1', 'a2'], files: { 'src/a.js': 'a\n' } })

  tm.write('a1', 'src/a.js', 'a\nb\n')
  const ask = await tm.as('a1', ['review', 'ask', '-m', 'add b', '-r', 'a2'])
  t.ok(/asked for review: A1/.test(ask.stdout), 'a1 asks a2: ' + ask.stdout + ask.stderr)

  // what a2's Review panel lists, once a2 has main (reads and runs here use a2's testnet)
  as(t, tm, 'a2')
  await tm.as('a2', ['fetch'])
  let list = await backend.review(tm.agents.a2)
  const entry = list.find((e) => e.id === 'A1')
  t.ok(entry, 'A1 waits on a2')
  t.is(entry.kind, 'ask')
  t.is(entry.by, 'a1')
  t.absent(entry.mine)
  const detail = await backend.detail(tm.agents.a2, { id: 'A1' })
  t.ok(/^ask A1 /.test(detail) && detail.includes('+b'), 'the ask with its diff')

  // who an ask can name: teammates, not yourself and not the hub
  const people = await backend.team(tm.agents.a1, { paths: ['/src/a.js'] })
  t.alike(
    people.map((p) => p.handle),
    ['a2', 'owner'],
    "a1's teammates to pick from"
  )

  // a1 sees its own ask there too
  const mine = (await backend.review(tm.agents.a1)).find((e) => e.id === 'A1')
  t.ok(mine && mine.mine, "a1's own ask, marked as theirs")

  // a2 approves from the UI: the real command on a run worker
  const client = new Client({ cwd: tm.agents.a2 })
  t.teardown(() => client.close())
  const approved = await client.run(['review', 'approve', 'A1', '-m', 'lgtm'])
  t.is(approved.code, 0, approved.lines.join('\n'))
  t.ok(approved.lines.some((l) => /^A1: approved; 1\/1 approvals, approved/.test(l)))
  list = await client.read('review')
  t.absent(
    list.some((e) => e.id === 'A1'),
    'approved as it stands: off the panel'
  )

  // a1 lands it (approved), then shows a2 a landed change
  await tm.as('a1', ['fetch'])
  const landed = await tm.as('a1', ['land', '-m', 'add b'])
  t.ok(/landed A1 as #\d+/.test(landed.stdout), 'the approved ask lands: ' + landed.stdout)
  tm.write('a1', 'src/c.js', 'c\n')
  const shown = await tm.as('a1', ['land', '-m', 'add c', '--reviewers', 'a2'])
  const seq = /landed #(\d+)/.exec(shown.stdout)[1]

  await tm.as('a2', ['fetch'])
  const change = (await client.read('review')).find((e) => e.kind === 'change')
  t.ok(change, 'the Show waits on a2')
  t.is(change.id, seq)
  const changes = await client.run(['review', 'changes', seq, '-m', 'src/c.js:1 say why'])
  t.is(changes.code, 0, changes.lines.join('\n'))
  t.ok(changes.lines.some((l) => l.startsWith(`#${seq}: requested changes`)))
  t.absent(
    (await client.read('review')).some((e) => e.kind === 'change'),
    'reviewed: off the panel'
  )

  // an ask naming nobody: anyone may review it, so it is in everyone's inbox (CLI and UI)
  tm.write('a1', 'src/d.js', 'd\n')
  const open = await tm.as('a1', ['review', 'ask', '-m', 'anyone?'])
  const aid = /asked for review: (A\d+)/.exec(open.stdout)[1]
  t.ok(/asked anyone/.test(open.stdout), 'it names nobody: ' + open.stdout)
  await tm.as('a2', ['fetch'])
  const inbox = await tm.as('a2', ['review', 'inbox', '--offline'])
  t.ok(
    new RegExp(`^${aid} 0/1 by a1, unassigned \\(anyone may review\\) :: anyone\\?$`, 'm').test(
      inbox.stdout
    ),
    'the CLI inbox lists it, marked: ' + inbox.stdout
  )
  const json = await tm.as('a2', ['review', 'inbox', '--json', '--offline'])
  const row = json.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((e) => e.ask === aid)
  t.ok(row && row.unassigned, 'and --json says unassigned')
  const own = await tm.as('a1', ['review', 'inbox', '--offline'])
  t.absent(own.stdout.includes(aid), "not in its author's inbox")
  const panel = (await client.read('review')).find((e) => e.id === aid)
  t.ok(panel && panel.unassigned && !panel.mine, 'the Review panel lists it as unassigned')

  const ok = await client.run(['review', 'approve', aid])
  t.is(ok.code, 0, ok.lines.join('\n'))
  const after = await tm.as('a2', ['review', 'inbox', '--offline'])
  t.absent(after.stdout.includes(aid), 'approved as it stands: out of the inbox')
})

test('ui tasks: file, start, stop, done and drop from the UI; a teammate sees the lead', async (t) => {
  const tm = await team(t, { agents: ['a1', 'a2'], files: { 'src/a.js': 'a\n' } })
  as(t, tm, 'a2')
  const client = new Client({ cwd: tm.agents.a2 })
  t.teardown(() => client.close())
  const task = (id) => client.read('tasks').then((l) => l.find((e) => e.id === id))

  const filed = await client.run(['task', 'new', 'cache distances'])
  t.is(filed.code, 0, filed.lines.join('\n'))
  const id = /task (T[0-9a-f]+)/.exec(filed.lines.join('\n'))[1]
  let e = await task(id)
  t.ok(e && e.mine && !e.lead && !e.onIt, 'on the board, nobody on it')

  const started = await client.run(['task', 'start', id])
  t.is(started.code, 0, started.lines.join('\n'))
  e = await task(id)
  t.is(e.lead, 'you')
  t.ok(e.onIt && e.text.startsWith('lead you'), 'a2 leads it')

  await tm.as('a1', ['fetch'])
  const seen = (await backend.tasks(tm.agents.a1)).find((x) => x.id === id)
  t.ok(seen && seen.lead === 'a2' && !seen.mine && !seen.onIt, "a1's board: a2 leads it")

  const stopped = await client.run(['task', 'stop', id])
  t.is(stopped.code, 0, stopped.lines.join('\n'))
  e = await task(id)
  t.ok(e && !e.lead && !e.onIt, 'stopped: open again')

  const done = await client.run(['task', 'done', id])
  t.is(done.code, 0, done.lines.join('\n'))
  t.absent(await task(id), 'done: off the board')

  const other = await client.run(['task', 'new', 'never mind'])
  const oid = /task (T[0-9a-f]+)/.exec(other.lines.join('\n'))[1]
  const dropped = await client.run(['task', 'drop', oid])
  t.is(dropped.code, 0, dropped.lines.join('\n'))
  t.absent(await task(oid), 'dropped: off the board')
})
