// Repo ABI upgrades across hs versions (lib/abi.js, docs/DESIGN.md "Rules versioning"): every
// peer judges ops by the repo's ABI, an owner moves it on one step at a time, and a peer whose
// build is older stops (no fork, writes refused) until it runs a newer hs, then catches up.
// An older build is stood in for by Repo's maxAbi; ABI 2 is a temporary row in the table.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const abi = require('../lib/abi')
const { settle } = require('./helpers/settle')

function withAbi2(t) {
  const last = abi.TABLE[abi.TABLE.length - 1]
  abi.TABLE.push({ abi: 2, maxOpId: last.maxOpId, schemaVersion: last.schemaVersion })
  t.teardown(() => abi.TABLE.pop())
}

async function peer(t, dir, opts) {
  const store = new Corestore(dir)
  const repo = new Repo(store, opts)
  await repo.ready()
  return {
    repo,
    store,
    async close() {
      await repo.close()
      await store.close()
    }
  }
}

function link(x, y) {
  const s1 = x.store.replicate(true)
  const s2 = y.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => {
    s1.destroy()
    s2.destroy()
  }
}

test('genesis: the first op records the ABI and bootstrap weight', async (t) => {
  const a = await peer(t, await tmp(t), {})
  t.teardown(() => a.close())
  const g = await a.repo.genesis()
  t.is(g.abi, abi.DEFAULT, 'a new repo starts at the default ABI')
  t.is(g.bootstrapWeight, 2)
  t.is(g.encrypted, false)
  t.is((await a.repo.meta()).seq, 0, 'genesis is not a changeset')

  // a peer that opens the repo with another bootstrap weight than genesis says is refused
  const bdir = await tmp(t)
  const b = await peer(t, bdir, { key: a.repo.key, bootstrapWeight: 1 })
  t.teardown(() => b.close())
  const unlink = link(a, b)
  t.teardown(unlink)
  await settle([a.repo, b.repo], { until: async () => (await b.repo.genesis()).abi > 0 })
  await t.exception(() => b.repo.checkGenesis(), /genesis says bootstrap weight 2/)
})

test('upgrade: owner only, one ABI at a time; an older peer stops, then catches up', async (t) => {
  t.timeout(120_000)
  withAbi2(t)
  const a = await peer(t, await tmp(t), { maxAbi: 2 })
  t.teardown(() => a.close())
  const bdir = await tmp(t)
  let b = await peer(t, bdir, { key: a.repo.key, maxAbi: 1 })
  let unlink = link(a, b)

  await a.repo.addWriter(b.repo.writerKey, { handle: 'b1' })
  await settle([a.repo, b.repo], { until: () => b.repo.writable })
  t.ok(b.repo.writable, 'b is a writer')

  t.is((await b.repo.upgrade(2)).outcome.status, 'invalid', 'a non-owner cannot upgrade')
  t.is((await a.repo.upgrade(3)).outcome.status, 'invalid', 'upgrades go one ABI at a time')
  t.is((await a.repo.upgrade(1)).outcome.status, 'accepted', 'to the current ABI: a no-op')

  // before the upgrade, both builds compute the same main
  await settle([a.repo, b.repo], { converge: true })
  t.alike((await a.repo.meta()).hash, (await b.repo.meta()).hash, 'same main before')

  const up = await a.repo.upgrade(2)
  t.is(up.outcome.status, 'accepted', 'the owner moves the repo to ABI 2')
  t.is((await a.repo.genesis()).abi, 2)

  await settle([b.repo], { until: () => !!b.repo.interrupted, timeout: 15_000 })
  t.alike(b.repo.interrupted, { unsupportedAbi: 2, supported: 1 }, 'the older peer stopped')
  t.is((await b.repo.genesis()).abi, 1, 'it never applied the upgrade')
  const ws = await b.repo.workspace('w')
  await ws.commit([{ path: '/b.txt', content: b4a.from('b\n') }])
  await t.exception(
    () => ws.land({ message: 'b' }),
    /uses ABI 2, newer than this hs supports \(1\)/
  )

  unlink()
  await b.close()

  // b updates its hs: the same store, a build that knows ABI 2
  b = await peer(t, bdir, { key: a.repo.key, maxAbi: 2 })
  t.teardown(() => b.close())
  unlink = link(a, b)
  t.teardown(unlink)
  await settle([a.repo, b.repo], { converge: true })
  t.absent(b.repo.interrupted, 'no interrupt with the newer build')
  t.is((await b.repo.genesis()).abi, 2, 'caught up to ABI 2')
  t.alike((await a.repo.meta()).hash, (await b.repo.meta()).hash, 'same main after')
  const ws2 = await b.repo.workspace('w2')
  await ws2.commit([{ path: '/b2.txt', content: b4a.from('b2\n') }])
  t.is((await ws2.land({ message: 'b2' })).outcome.status, 'accepted', 'and lands again')
})

test('fast-forward trusts settlers only, and refuses a view past its ABI', async (t) => {
  t.timeout(60_000)
  withAbi2(t)
  const a = await peer(t, await tmp(t), { maxAbi: 2 })
  t.teardown(() => a.close())
  const h = await peer(t, await tmp(t), { key: a.repo.key, maxAbi: 2 })
  t.teardown(() => h.close())
  const unlink = link(a, h)
  t.teardown(unlink)
  await a.repo.addWriter(h.repo.writerKey, { indexer: true, handle: 'hub' })
  await settle([a.repo, h.repo], { until: () => h.repo.writable })
  await h.repo.ack()
  await settle([a.repo, h.repo], { converge: true })

  // the newest settler head: the hub's latest op, which a's own view knows as a settler
  const head = await a.repo._mostRecentTrusted(a.repo.main.view, a.repo.main.view)
  t.ok(head && b4a.equals(head.key, h.repo.writerKey), 'the hub is the head to boot from')
  t.is(head.length, h.repo.main.local.length)

  // a hub the reference view doesn't know as one is skipped
  t.is(await a.repo._settlerIn(a.repo.main.view, b4a.alloc(32, 1)), false)

  // a candidate at an ABI past this build is refused; at a known one it passes
  await a.repo._checkCandidate(a.repo.main.view, 1)
  t.is((await a.repo.upgrade(2)).outcome.status, 'accepted')
  await t.exception(() => a.repo._checkCandidate(a.repo.main.view, 1), /past this build \(1\)/)
  await a.repo._checkCandidate(a.repo.main.view, 2)
})
