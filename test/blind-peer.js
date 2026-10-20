// A real blind peer as the team's holder: it keeps main and landed content available after
// the author leaves, without being able to read it (encrypted repo).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const BlindPeer = require('blind-peer')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Network = require('../lib/net')

const put = (path, s) => ({ path, content: b4a.from(s) })

test('blind peer keeps an encrypted repo readable after its author leaves', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet

  const bp = new BlindPeer(await tmp(t), { bootstrap })
  await bp.listen()
  t.teardown(() => bp.close(), { order: 1 })
  const blindPeers = [bp.publicKey]
  const encryptionKey = crypto.randomBytes(32)

  const a = await peer(t, null, bootstrap, { blindPeers }, { encryptionKey })
  const ws = await a.repo.workspace('w')
  await ws.commit([put('/secret.txt', 'top secret\n')])
  t.is((await ws.land()).outcome.status, 'accepted')
  a.net.seed(ws) // landed: priority 1, must outlive GC

  // wait until the blind peer holds every block of our oplog and the landed blobs
  await waitFor(async () => {
    for (const core of [a.repo.main.local, ws.blobs.core, ws.tree]) {
      const copy = bp.store.get({ key: core.key })
      await copy.ready()
      const ok = copy.contiguousLength >= core.length
      await copy.close()
      if (!ok) return false
    }
    return true
  })
  t.pass('blind peer holds the oplog, workspace tree and blobs')

  const blob = bp.store.get({ key: ws.blobs.core.key })
  await blob.ready()
  const raw = await blob.get(0, { raw: true })
  t.absent(b4a.toString(raw).includes('top secret'), 'blind peer only has ciphertext')
  await blob.close()

  await a.close()

  const b = await peer(t, a.repo.key, bootstrap, { blindPeers }, { encryptionKey })
  await waitFor(async () => {
    await b.repo.update()
    return (await b.repo.meta()).seq === 1
  })
  const drive = b.repo.drive()
  t.alike(await drive.get('/secret.txt'), b4a.from('top secret\n'), 'served by the blind peer')
  await drive.close()
})

async function peer(t, key, bootstrap, netOpts = {}, repoOpts = {}) {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store, { key, ...repoOpts })
  await repo.ready()
  const net = new Network(repo, { bootstrap, ...netOpts })
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

async function waitFor(fn, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
