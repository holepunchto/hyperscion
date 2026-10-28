// Spike B: a workspace Hyperdrive forked from main via a cross-core hyperbee2,
// reading blobs that live in main's blobs core and writing to its own.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const Hyperblobs = require('hyperblobs')
const Hyperdrive = require('hyperdrive')
const tmp = require('test-tmp')

async function makeDrive(store, name) {
  const ns = store.namespace(name)
  const db = new Hyperbee(ns)
  const blobs = new Hyperblobs(ns.get({ name: 'blobs' }))
  const drive = new Hyperdrive(ns, { _db: db, blobs })
  await drive.ready()
  return drive
}

test('workspace drive forks main and reads foreign blobs', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())

  const main = await makeDrive(store, 'main')
  main.batch()
  for (let i = 0; i < 1000; i++) await main.put(`/src/${i}.js`, b4a.from(`file ${i}`))
  await main.put('/README.md', b4a.from('hello'))
  await main.flush()

  const head = main.head
  t.is(head.length, main.core.length)

  const readme = await main.entry('/README.md')
  t.alike(readme.value.blob.core, main.blobs.core.key, 'blob core is stamped')

  const ws = await makeDrive(store, 'ws')
  ws.db.move(head) // O(1) fork
  t.is(ws.core.length, 0)

  t.alike(await ws.get('/README.md'), b4a.from('hello'), 'reads foreign blob through fork')

  ws.batch()
  await ws.put('/README.md', b4a.from('hello, world'))
  await ws.put('/src/new.js', b4a.from('new'))
  await ws.del('/src/7.js')
  await ws.flush()

  t.ok(ws.core.length <= 8, `fork commit appended ${ws.core.length} tree blocks`)
  t.is(ws.blobs.core.length, 2, 'only new content was uploaded')

  t.alike(await ws.get('/README.md'), b4a.from('hello, world'))
  t.alike(await ws.get('/src/new.js'), b4a.from('new'))
  t.alike(await ws.get('/src/500.js'), b4a.from('file 500'))
  t.is(await ws.entry('/src/7.js'), null, 'del respects batch')
  t.alike(await main.get('/README.md'), b4a.from('hello'), 'main unchanged')

  // stream read across cores
  const chunks = []
  for await (const c of ws.createReadStream('/src/9.js')) chunks.push(c)
  t.alike(b4a.concat(chunks), b4a.from('file 9'))

  // cross-core diff via drive api: main@head vs workspace
  const diff = []
  for await (const d of ws.diff(head)) diff.push(d)
  t.is(diff.length, 3)
  t.alike(diff.map((d) => (d.left || d.right).key).sort(), [
    '/README.md',
    '/src/7.js',
    '/src/new.js'
  ])

  // checkout of main version through workspace drive
  const snap = ws.checkout(head)
  t.alike(await snap.get('/README.md'), b4a.from('hello'))
  t.ok(await snap.has('/src/7.js'))
  await snap.close()
})
