// Two peers over a local DHT testnet: clone, lazy blob fetch, add-writer, land back.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Network = require('../lib/net')

const put = (path, s) => ({ path, content: b4a.from(s) })

test('clone, read lazily, become writer, land back', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet

  const a = await peer(t, null, bootstrap)
  const ws = await a.repo.workspace('w')
  const files = []
  for (let i = 0; i < 200; i++) files.push(put(`/src/${i}.txt`, `file ${i}\n`))
  await ws.commit(files)
  t.is((await ws.land({ message: 'init' })).outcome.status, 'accepted')

  const b = await peer(t, a.repo.key, bootstrap)
  t.ok(await b.net.waitForPeers(), 'b connected')
  t.ok(await b.net.settle(), 'b settled')

  t.is((await b.repo.meta()).seq, 1, 'b sees main')
  t.ok(!b.repo.writable, 'b is read-only until added')

  // only the requested file's blob blocks get fetched
  const drive = b.repo.drive()
  t.alike(await drive.get('/src/42.txt'), b4a.from('file 42\n'))
  const blobs = await drive.getBlobsFor((await drive.entry('/src/42.txt')).value.blob)
  const held = await countLocal(blobs.core)
  t.comment(`b holds ${held}/${blobs.core.length} blob blocks`)
  t.ok(held < blobs.core.length, 'sparse: did not download every blob')
  await drive.close()

  await a.repo.addWriter(b.repo.writerKey, { indexer: false })
  await b.net.settle()
  t.ok(b.repo.writable, 'b became a writer')

  const bws = await b.repo.workspace('b-feature')
  await bws.commit([put('/src/42.txt', 'changed by b\n'), put('/NEW.md', 'new\n')])
  const res = await bws.land({ message: 'from b' })
  t.is(res.outcome.status, 'accepted')
  t.ok(await b.net.uploaded(), 'b uploaded its cores to a peer')

  await a.net.settle()
  t.is((await a.repo.meta()).seq, 2, 'a sees b land')
  const ad = a.repo.drive()
  t.alike(await ad.get('/src/42.txt'), b4a.from('changed by b\n'))
  t.alike(await ad.get('/NEW.md'), b4a.from('new\n'))
  await ad.close()
})

test('encrypted repo: clone and read across peers', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet
  const encryptionKey = require('hypercore-crypto').randomBytes(32)

  const a = await peer(t, null, bootstrap, {}, { encryptionKey })
  const ws = await a.repo.workspace('w')
  await ws.commit([put('/secret.txt', 'top secret\n')])
  t.is((await ws.land()).outcome.status, 'accepted')

  // blocks at rest are not plaintext
  const raw = await ws.blobs.core.get(0, { raw: true })
  t.absent(b4a.toString(raw).includes('top secret'), 'blob stored encrypted')

  const b = await peer(t, a.repo.key, bootstrap, {}, { encryptionKey })
  await b.net.waitForPeers()
  await b.net.settle()
  const drive = b.repo.drive()
  t.alike(await drive.get('/secret.txt'), b4a.from('top secret\n'), 'peer with key reads it')
  await drive.close()

  await a.repo.addWriter(b.repo.writerKey)
  await b.net.settle()
  const bws = await b.repo.workspace('b')
  await bws.commit([put('/from-b.txt', 'b\n')])
  t.is((await bws.land()).outcome.status, 'accepted')
  await a.net.settle()
  const ad = a.repo.drive()
  t.alike(await ad.get('/from-b.txt'), b4a.from('b\n'))
  await ad.close()
})

test('a mirror keeps main readable after its authors go offline', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet

  const a = await peer(t, null, bootstrap)
  const ws = await a.repo.workspace('w')
  await ws.commit([put('/one.txt', 'one\n'), put('/two.txt', 'two\n')])
  t.is((await ws.land()).outcome.status, 'accepted')

  const c = await peer(t, a.repo.key, bootstrap, { mirror: true })
  await c.net.waitForPeers()
  await c.net.settle()
  await waitFor(() => c.net.mirrored >= 1)
  t.is(c.net.mirrored, 1, 'mirror holds changeset #1')

  await a.close()

  const d = await peer(t, a.repo.key, bootstrap)
  t.ok(await d.net.waitForPeers(), 'd connected to the mirror')
  await d.net.settle()
  const drive = d.repo.drive()
  t.alike(await drive.get('/two.txt'), b4a.from('two\n'), 'content served by the mirror')
  await drive.close()
})

test('after prefetch, everything in the sparse set works offline', async (t) => {
  const Worktree = require('../lib/worktree')
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet

  const a = await peer(t, null, bootstrap)
  const wa = await a.repo.workspace('w')
  await wa.commit([put('/src/a.js', 'a\n'), put('/src/b.js', 'b\n'), put('/docs/x.md', 'x\n')])
  await wa.land()

  const mirror = await peer(t, a.repo.key, bootstrap, { mirror: true })
  await mirror.net.waitForPeers()
  await mirror.net.settle()
  await waitFor(() => mirror.net.mirrored >= 1)
  await a.close() // the author is gone; only the mirror holds the content

  const b = await peer(t, a.repo.key, bootstrap)
  t.ok(await b.net.waitForPeers(), 'b found the mirror')
  await b.net.settle()
  const ws = await b.repo.workspace('w')
  const res = await ws.prefetch({ sparse: ['/src'], timeout: 5000 })
  t.alike(res.missing, [], 'nothing missing for /src')
  t.ok(res.fetched >= 2)

  await b.net.close() // offline from here on
  ws.io = { wait: false }

  const dir = await tmp(t)
  const wt = new Worktree(dir, { sparse: ['/src'] })
  const co = await wt.checkout(ws)
  t.alike(co.missing, [], 'checkout works offline')
  t.is(co.written, 2)
  t.alike([...(await wt.status(ws))], [])
  t.alike(await ws.drive.get('/src/b.js', { wait: false }), b4a.from('b\n'), 'cat works offline')

  await ws.commit([put('/src/a.js', 'a2\n')])
  t.is((await ws.changes()).length, 1, 'diff works offline')
  await ws.sync() // up to date, nothing to fetch
})

test('without a holder, prefetch reports what is missing instead of stalling', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet

  const a = await peer(t, null, bootstrap)
  const b = await peer(t, a.repo.key, bootstrap)
  await b.net.waitForPeers()

  const wa = await a.repo.workspace('w')
  await wa.commit([put('/only-on-a.txt', 'a\n')])
  await wa.land()
  await b.net.settle() // b knows the changeset exists...
  await a.close() // ...but its author leaves before anyone fetched the content

  const ws = await b.repo.workspace('w')
  const started = Date.now()
  const res = await ws.prefetch({ timeout: 1000 })
  t.alike(
    res.missing.map((m) => m.path),
    ['/only-on-a.txt']
  )
  t.ok(Date.now() - started < 10_000, 'bounded by the timeout')
})

async function waitFor(fn, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function peer(t, key, bootstrap, opts = {}, repoOpts = {}) {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store, { key, ...repoOpts })
  await repo.ready()
  const net = new Network(repo, { bootstrap, ...opts })
  await net.ready()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await net.close()
    await repo.close()
    await store.close()
  }
  t.teardown(close, { order: -1 })
  return { store, repo, net, close }
}

async function countLocal(core) {
  let n = 0
  for (let i = 0; i < core.length; i++) if (await core.has(i)) n++
  return n
}
