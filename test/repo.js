const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')

async function create(t) {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store)
  await repo.ready()
  t.teardown(async () => {
    await repo.close()
    await store.close()
  })
  return repo
}

const put = (path, s) => ({ path, content: b4a.from(s) })

test('commit, land, read main, log', async (t) => {
  const repo = await create(t)

  const ws = await repo.workspace('feature')
  t.is(await ws.commit([put('/README.md', 'hello\n'), put('/src/a.js', 'a\n')]), 2)
  t.is((await ws.changes()).length, 2)

  const { outcome } = await ws.land({ message: 'initial', author: 'tester' })
  t.is(outcome.status, 'accepted')
  t.is(outcome.seq, 1)

  const drive = repo.drive()
  t.alike(await drive.get('/README.md'), b4a.from('hello\n'))
  t.alike(await drive.get('/src/a.js'), b4a.from('a\n'))
  await drive.close()

  t.is((await ws.changes()).length, 0, 'workspace synced after land')

  const log = []
  for await (const cs of repo.log()) log.push(cs)
  t.is(log.length, 1)
  t.is(log[0].message, 'initial')
  t.is(log[0].paths, 2)

  const hist = []
  for await (const cs of repo.log({ path: '/src/a.js' })) hist.push(cs.seq)
  t.alike(hist, [1])
})

test('conflict, sync with clean 3-way merge, re-land', async (t) => {
  const repo = await create(t)

  const seed = await repo.workspace('seed')
  await seed.commit([put('/f.txt', 'one\ntwo\nthree\nfour\nfive\n')])
  t.is((await seed.land()).outcome.status, 'accepted')

  const a = await repo.workspace('a')
  const b = await repo.workspace('b')

  await a.commit([put('/f.txt', 'ONE\ntwo\nthree\nfour\nfive\n')])
  await b.commit([put('/f.txt', 'one\ntwo\nthree\nfour\nFIVE\n'), put('/g.txt', 'g\n')])

  t.is((await a.land()).outcome.status, 'accepted')

  const rb = await b.land()
  t.is(rb.outcome.status, 'conflict')
  t.alike(rb.outcome.conflicts, ['/f.txt'])

  const sync = await b.sync()
  t.alike(sync.merged, ['/f.txt'])
  t.alike(sync.conflicts, [])

  t.alike(await b.drive.get('/f.txt'), b4a.from('ONE\ntwo\nthree\nfour\nFIVE\n'))
  t.is((await b.land()).outcome.status, 'accepted')

  const drive = repo.drive()
  t.alike(await drive.get('/f.txt'), b4a.from('ONE\ntwo\nthree\nfour\nFIVE\n'))
  t.alike(await drive.get('/g.txt'), b4a.from('g\n'))
  await drive.close()

  const hist = []
  for await (const cs of repo.log({ path: '/f.txt' })) hist.push(cs.seq)
  t.alike(hist, [3, 2, 1])
})

test('true conflict leaves markers', async (t) => {
  const repo = await create(t)

  const seed = await repo.workspace('seed')
  await seed.commit([put('/f.txt', 'x\n')])
  await seed.land()

  const a = await repo.workspace('a')
  const b = await repo.workspace('b')
  await a.commit([put('/f.txt', 'from a\n')])
  await b.commit([put('/f.txt', 'from b\n')])
  await a.land()

  const sync = await b.sync()
  t.alike(sync.conflicts, ['/f.txt'])
  const content = b4a.toString(await b.drive.get('/f.txt'))
  t.ok(content.includes('<<<<<<<') && content.includes('from a') && content.includes('from b'))
})

test('identical content is deduplicated across workspaces', async (t) => {
  const repo = await create(t)
  const big = b4a.alloc(256 * 1024, 7)

  const a = await repo.workspace('a')
  await a.commit([{ path: '/big.bin', content: big }])
  await a.land()
  const uploaded = a.blobs.core.length
  t.ok(uploaded > 0)

  const b = await repo.workspace('b')
  await b.commit([{ path: '/copy.bin', content: big }])
  t.is(b.blobs.core.length, 0, 'no bytes uploaded for known content')
  await b.land()

  const drive = repo.drive()
  t.alike(await drive.get('/copy.bin'), big)
  await drive.close()
})

test('workspaces persist across reopen', async (t) => {
  const dir = await tmp(t)

  let store = new Corestore(dir)
  let repo = new Repo(store)
  await repo.ready()
  const ws = await repo.workspace('w')
  await ws.commit([put('/a', 'a')])
  const head = ws.head()
  await repo.close()
  await store.close()

  store = new Corestore(dir)
  repo = new Repo(store)
  await repo.ready()
  t.alike(await repo.listWorkspaces(), ['w'])
  const again = await repo.workspace('w', { create: false })
  t.alike(again.head(), head)
  t.alike(await again.drive.get('/a'), b4a.from('a'))
  t.is((await again.land()).outcome.status, 'accepted')
  await repo.close()
  await store.close()

  // the post-land sync moved the root without appending; it must survive a reopen
  store = new Corestore(dir)
  repo = new Repo(store)
  await repo.ready()
  const third = await repo.workspace('w', { create: false })
  t.is((await third.changes()).length, 0, 'landed changes are not pending after reopen')
  t.is(third.state.base.seq, 1)
  await repo.close()
  await store.close()
})

test('union merge for paths marked in .hsattributes: concurrent appends never conflict', async (t) => {
  const repo = await create(t)

  const seed = await repo.workspace('seed')
  await seed.commit([
    put('/.hsattributes', 'NOTES.md merge=union\n'),
    put('/NOTES.md', '# notes\n- [hub] start\n'),
    put('/code.js', 'a\n')
  ])
  await seed.land()

  const a = await repo.workspace('a')
  const b = await repo.workspace('b')
  await a.commit([put('/NOTES.md', '# notes\n- [hub] start\n- [a] from a\n')])
  await b.commit([put('/NOTES.md', '# notes\n- [hub] start\n- [b] from b\n')])

  t.is((await a.land()).outcome.status, 'accepted')
  const res = await b.land({ rebase: 1 })
  t.is(res.outcome.status, 'accepted', 'second append lands after a union rebase')
  t.is(res.attempts, 2)

  const drive = repo.drive()
  const notes = b4a.toString(await drive.get('/NOTES.md'))
  t.ok(notes.includes('- [a] from a') && notes.includes('- [b] from b'), 'both lines kept')
  t.absent(notes.includes('<<<<<<<'), 'no conflict markers')
  await drive.close()

  // files without the attribute still get real conflicts
  const c1 = await repo.workspace('c1')
  const c2 = await repo.workspace('c2')
  await c1.commit([put('/code.js', 'one\n')])
  await c2.commit([put('/code.js', 'two\n')])
  await c1.land()
  const sync = await c2.sync()
  t.alike(sync.conflicts, ['/code.js'])
})

test('show: each changeset records before/after entries per path', async (t) => {
  const merge = require('../lib/merge')
  const repo = await create(t)
  const ws = await repo.workspace('w')
  await ws.commit([put('/f.txt', 'one\ntwo\nthree\n'), put('/gone.txt', 'x\n')])
  await ws.land({ message: 'first' })
  await ws.commit([put('/f.txt', 'one\nTWO\nthree\n'), { path: '/gone.txt', content: null }])
  await ws.land({ message: 'second' })

  const res = await repo.show(2)
  t.is(res.cs.message, 'second')
  t.alike(res.files.map((f) => (f.deleted ? '-' : '') + f.path).sort(), ['-/gone.txt', '/f.txt'])

  const drive = repo.drive()
  const read = async (v) => {
    if (!v) return null
    const entry = require('compact-encoding').decode(require('hyperdrive/lib/encoding'), v)
    return (await drive.getBlobsFor(entry.blob)).get(entry.blob)
  }
  const f = res.files.find((x) => x.path === '/f.txt')
  const text = merge.unifiedDiff(f.path, await read(f.prev), await read(f.next))
  t.ok(text.includes('-two') && text.includes('+TWO'), 'diff shows the edit')
  const g = res.files.find((x) => x.path === '/gone.txt')
  t.ok(g.prev && !g.next, 'deletion has prev only')
  await drive.close()
})

test('lastChange and changesetsBetween name who changed what (rebase and incoming messages)', async (t) => {
  const repo = await create(t)
  const a = await repo.workspace('a')
  await a.commit([put('/NOTES.md', 'n1\n'), put('/a.js', 'a\n')])
  await a.land({ message: 'first', author: 'a1' })
  await a.commit([put('/NOTES.md', 'n2\n')])
  await a.land({ message: 'second', author: 'a2' })
  await a.commit([put('/b.js', 'b\n')])
  await a.land({ message: 'third', author: 'a3' })

  const last = await repo.lastChange('/NOTES.md')
  t.is(last.seq, 2)
  t.is(last.author, 'a2')
  t.is(await repo.lastChange('/missing.js'), null)

  t.alike(
    (await repo.changesetsBetween(1, 3)).map((cs) => cs.message),
    ['second', 'third']
  )
  t.alike(await repo.changesetsBetween(3, 3), [])
})
