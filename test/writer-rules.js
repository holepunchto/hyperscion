// ABI 1's writer rules (lib/apply.js addWriter/removeWriter): an owner adds and removes
// anyone; a hub admits new writers and hubs and removes other hubs; nobody else changes who
// writes. Also: a refused add changes nothing, a removed writer stops counting as a reviewer,
// a review names one target, and limits count bytes.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const { settle } = require('./helpers/settle')

async function team(t, n) {
  const repos = []
  for (let i = 0; i < n; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : repos[0].key })
    await repo.ready()
    repos.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  for (const other of repos.slice(1)) {
    const s1 = repos[0].store.replicate(true)
    const s2 = other.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    t.teardown(() => {
      s1.destroy()
      s2.destroy()
    })
  }
  return repos
}

const key = () => crypto.randomBytes(32)
const status = async (p) => (await p).outcome.status

test('only owners (and hubs, for new writers and hubs) change who writes', async (t) => {
  t.timeout(60_000)
  const [owner, hub, agent] = await team(t, 3)
  await owner.addWriter(hub.writerKey, { indexer: true, handle: 'hub' })
  await owner.addWriter(agent.writerKey, { handle: 'a1' })
  await settle([owner, hub, agent], { until: () => hub.writable && agent.writable })
  await settle([owner, hub, agent])

  // a plain writer changes nothing about who writes
  t.is(await status(agent.addWriter(key(), { handle: 'x1' })), 'invalid', 'agent adds: no')
  t.is(await status(agent.removeWriter(hub.writerKey)), 'invalid', 'agent removes a hub: no')
  t.is(await status(agent.removeWriter(owner.writerKey)), 'invalid', 'agent removes the owner: no')

  // a hub admits new writers and hubs, nothing more
  await settle([owner, hub, agent])
  t.is(await status(hub.addWriter(key(), { handle: 'n1' })), 'accepted', 'hub admits a writer')
  const hub2 = key()
  t.is(
    await status(hub.addWriter(hub2, { indexer: true, handle: 'hub2' })),
    'accepted',
    'and a hub'
  )
  t.is(await status(hub.addWriter(key(), { owner: true })), 'invalid', 'not an owner')
  t.is(await status(hub.addWriter(key(), { human: true })), 'invalid', 'not a person')
  t.is(await status(hub.addWriter(agent.writerKey, { handle: 'renamed' })), 'invalid', 'no renames')
  t.is(await status(hub.removeWriter(agent.writerKey)), 'invalid', 'a hub removes no agent')
  t.is(await status(hub.removeWriter(hub2)), 'accepted', 'but another hub')

  // a refused add leaves the handle index alone (it used to rename before refusing)
  await settle([owner, hub, agent])
  t.alike(await owner.keyOf('a1'), agent.writerKey, 'a1 still names the agent')
  t.is(await owner.keyOf('renamed'), null, 'the refused handle was never taken')

  // the owner does all of it, and a writer can always step away itself
  await settle([owner, hub, agent])
  t.is(
    await status(owner.addWriter(agent.writerKey, { handle: 'a2' })),
    'accepted',
    'owner renames'
  )
  t.is(await status(owner.removeWriter(agent.writerKey)), 'accepted', 'owner removes')
  t.is(
    await status(hub.addWriter(agent.writerKey, { handle: 'a2' })),
    'invalid',
    'a hub does not let a removed writer back'
  )
  t.is(
    await status(owner.addWriter(agent.writerKey, { handle: 'a2' })),
    'accepted',
    'the owner does'
  )
  await settle([owner, hub, agent])
  t.is(await status(agent.removeWriter(agent.writerKey)), 'accepted', 'a writer can leave')
})

test('a removed writer is no reviewer; a review names one target; limits count bytes', async (t) => {
  t.timeout(60_000)
  const [owner, agent] = await team(t, 2)
  await owner.addWriter(agent.writerKey, { handle: 'a1' })
  await settle([owner, agent], { until: () => agent.writable })
  await settle([owner, agent])
  t.is(await status(owner.removeWriter(agent.writerKey)), 'accepted')
  await settle([owner, agent])

  // proposing with the removed writer as reviewer: the handle no longer resolves
  const ws = await owner.workspace('w')
  await ws.commit([{ path: '/a.txt', content: b4a.from('a\n') }])
  const asked = await ws.propose({ message: 'look', reviewers: ['a1'] })
  t.is(asked.outcome.status, 'invalid', 'a removed writer cannot be named as reviewer')

  const two = await owner.review({ verdict: 3, proposal: 1, seq: 1, time: Date.now() })
  t.is(two.outcome.status, 'invalid', 'a review naming two targets')

  const now = Date.now()
  const item = (title) =>
    owner.itemOp({ item: crypto.randomBytes(32), action: 1, time: now, at: now, title })
  t.is(await status(item('x'.repeat(300))), 'accepted', '300 ASCII bytes fit')
  t.is(await status(item('é'.repeat(151))), 'invalid', '151 two-byte characters (302 bytes) do not')
})
