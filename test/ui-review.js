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
})
