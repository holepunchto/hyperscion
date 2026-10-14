const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Watcher = require('../lib/watch')

const put = (path, s) => ({ path, content: b4a.from(s) })

test('watcher streams changesets in order, with file lists and path filters', async (t) => {
  const [a, b] = await repos(t, 2)
  link(a, b)

  const all = []
  const onlySrc = []
  const w1 = new Watcher(b)
  const w2 = new Watcher(b, { paths: ['src'] })
  w1.on('changeset', (cs) => all.push(cs))
  w2.on('changeset', (cs) => onlySrc.push(cs.seq))
  await w1.start()
  await w2.start()
  t.teardown(() => Promise.all([w1.close(), w2.close()]))

  const ws = await a.workspace('w')
  await ws.commit([put('/README.md', 'r')])
  await ws.land({ message: 'docs' })
  await ws.commit([put('/src/a.js', 'a')])
  await ws.land({ message: 'code' })

  await until(() => all.length === 2, b)
  t.alike(
    all.map((cs) => [cs.seq, cs.message, cs.files]),
    [
      [1, 'docs', ['/README.md']],
      [2, 'code', ['/src/a.js']]
    ]
  )
  await until(() => onlySrc.length === 1, b)
  t.alike(onlySrc, [2], 'path filter')
})

test('watcher started with since replays exactly what came after it (feed resume, waits from base)', async (t) => {
  const [a] = await repos(t, 1)
  const ws = await a.workspace('w')
  for (const name of ['one', 'two', 'three']) {
    await ws.commit([put('/src/' + name + '.js', name)])
    await ws.land({ message: name })
  }

  const got = []
  const w = new Watcher(a, { since: 1 })
  w.on('changeset', (cs) => got.push(cs.message))
  await w.start()
  t.teardown(() => w.close())
  await until(() => got.length === 2, a)
  t.alike(got, ['two', 'three'], 'resumes after seq 1, nothing repeated or missed')

  const dep = []
  const wait = new Watcher(a, { since: 0, paths: ['/src/two.js'] })
  wait.on('changeset', (cs) => dep.push(cs.seq))
  await wait.start()
  t.teardown(() => wait.close())
  await until(() => dep.length === 1, a)
  t.alike(dep, [2], 'a wait from an older base sees a change that already landed')
})

test('watcher reports a reorg when a changeset it showed is replaced', async (t) => {
  const [a, b, c1, c2] = await repos(t, 4)
  const ab = link(a, b)
  await a.addWriter(b.writerKey, { indexer: true })
  await until(() => b.writable, a, b)
  await ab()

  // c1 only sees a, c2 only sees b, while a and b land concurrently on the same file
  const l1 = link(a, c1)
  const l2 = link(b, c2)
  const reorgs = { c1: [], c2: [] }
  const w1 = new Watcher(c1)
  const w2 = new Watcher(c2)
  w1.on('reorg', (r) => reorgs.c1.push(r))
  w2.on('reorg', (r) => reorgs.c2.push(r))
  await w1.start()
  await w2.start()
  t.teardown(() => Promise.all([w1.close(), w2.close()]))

  const wa = await a.workspace('wa')
  const wb = await b.workspace('wb')
  await wa.commit([put('/x.txt', 'from a')])
  await wb.commit([put('/x.txt', 'from b')])
  await wa.land({ message: 'a wins?' })
  await wb.land({ message: 'b wins?' })
  await until(async () => (await c1.meta()).seq === 1 && (await c2.meta()).seq === 1, c1, c2)

  // everyone meets: one of the two provisional #1s is replaced
  link(a, b)
  link(c1, c2)
  await until(
    async () => {
      const [m1, m2] = [await c1.meta(), await c2.meta()]
      return b4a.equals(m1.hash, m2.hash) && reorgs.c1.length + reorgs.c2.length >= 1
    },
    a,
    b,
    c1,
    c2
  )

  t.is(reorgs.c1.length + reorgs.c2.length, 1, 'exactly one observer saw history change')
  const r = reorgs.c1[0] || reorgs.c2[0]
  t.is(r.seq, 1)
  t.not(r.before.message, r.after && r.after.message, 'reports what was replaced')
  await l1()
  await l2()
})

async function repos(t, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : out[0].key })
    await repo.ready()
    out.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  return out
}

function link(x, y) {
  const s1 = x.store.replicate(true)
  const s2 = y.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return async () => {
    s1.destroy()
    s2.destroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function until(fn, ...repos) {
  for (let i = 0; i < 400; i++) {
    for (const r of repos) await r.update()
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}
