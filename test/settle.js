// Provisional -> settled -> final: seen markers, indexer acks, and how review feeds "final".
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const { getEncoding } = require('../lib/schema/spec')
const { OP_ACK } = require('../lib/apply')

const Op = getEncoding('@hs/op')
const put = (path, s) => ({ path, content: b4a.from(s) })

test('seen markers: recorded when they match main, ignored when forged', async (t) => {
  const { hub, b, settle } = await team(t)
  const wb = await b.workspace('wb')
  await wb.commit([put('/x', 'x')])
  const seq = (await wb.land()).outcome.seq
  await settle()

  await b.ack()
  await settle()
  t.is(await hub.seenBy(b.writerKey), seq, 'ack records what b had seen')

  // a forged marker claims a changeset hash that isn't on main
  await b.main.append(c.encode(Op, { type: OP_ACK, seen: { seq, hash: crypto.randomBytes(32) } }))
  await b.main.append(
    c.encode(Op, { type: OP_ACK, seen: { seq: 99, hash: crypto.randomBytes(32) } })
  )
  await settle()
  t.is(await hub.seenBy(b.writerKey), seq, 'forged markers change nothing')
})

test('a land settles when every indexer has seen it, not before', async (t) => {
  const { hub, b, settle } = await team(t)
  const wb = await b.workspace('wb')
  await wb.commit([put('/x', 'x')])
  const seq = (await wb.land({ message: 'ship it' })).outcome.seq
  await settle()

  let st = await b.landStatus(seq)
  t.is(st.state, 'provisional')
  t.ok(st.waiting[0].includes('hub to ack'))

  await b.ack() // a non-indexer seeing it doesn't settle it
  await settle()
  t.is((await b.landStatus(seq)).state, 'provisional')

  await hub.ack()
  await settle()
  st = await b.landStatus(seq)
  t.ok(st.settled && st.final, 'Ship: final once settled')
  t.is(st.kind, 'ship')
  t.ok(
    (await b.events()).some((e) => e.type === 'settled' && e.seq >= seq),
    'settled event'
  )
})

test('Show: final only once settled and approved by a requested reviewer', async (t) => {
  const { hub, b, c: cc, settle } = await team(t)
  const wb = await b.workspace('wb')
  await wb.commit([put('/pricing.js', 'p1')])
  const seq = (await wb.land({ reviewers: ['c1'] })).outcome.seq
  await settle()
  await hub.ack()
  await settle()

  let st = await b.landStatus(seq)
  t.is(st.kind, 'show')
  t.is(st.state, 'settled')
  t.alike(st.waiting, ['review from c1'])

  await cc.review({ seq, verdict: 2, comment: 'rounding' })
  await settle()
  st = await b.landStatus(seq)
  t.is(st.state, 'settled')
  t.alike(st.waiting, ['changes requested by c1'])

  await cc.review({ seq, verdict: 1 })
  await settle()
  st = await b.landStatus(seq)
  t.is(st.state, 'final', 'approval after changes makes it final')
})

test('Ask: an approved proposal is final once settled', async (t) => {
  const { hub, b, c: cc, settle } = await team(t)
  const wb = await b.workspace('wb')
  await wb.commit([put('/CONTRACTS.md', 'v2')])
  const id = (await wb.propose({ reviewers: ['c1'] })).outcome.proposal
  await settle()
  await cc.review({ proposal: id, verdict: 1, hash: (await cc.proposal(id)).hash })
  await settle()
  const seq = (await wb.land()).outcome.seq
  await settle()
  t.is((await b.landStatus(seq)).state, 'provisional')
  await hub.ack()
  await settle()
  const st = await b.landStatus(seq)
  t.is(st.kind, 'ask')
  t.is(st.state, 'final')
})

async function team(t) {
  const repos = []
  for (let i = 0; i < 3; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : repos[0].key })
    await repo.ready()
    repos.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  const [hub, b, cc] = repos
  for (const other of [b, cc]) {
    const s1 = hub.store.replicate(true)
    const s2 = other.store.replicate(false)
    s1.pipe(s2).pipe(s1)
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      for (const r of repos) await r.update()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  await hub.addWriter(hub.writerKey, { indexer: true, handle: 'hub' })
  await hub.addWriter(b.writerKey, { handle: 'b1' })
  await hub.addWriter(cc.writerKey, { handle: 'c1' })
  await settle()
  t.ok(b.writable && cc.writable)
  return { hub, b, c: cc, settle }
}

test('a hub gone for good: another indexer removes it and settlement resumes', async (t) => {
  // founder (bootstrap indexer), b (agent), hub (a second indexer: hubs run as non-bootstrap
  // indexers, since the bootstrap writer can't be removed safely yet); everyone linked
  const repos = []
  for (let i = 0; i < 3; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : repos[0].key })
    await repo.ready()
    repos.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  const [founder, b, hub] = repos
  const links = new Map()
  const link = (x, y) => {
    const s1 = x.store.replicate(true)
    const s2 = y.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    links.set(repos.indexOf(x) + '-' + repos.indexOf(y), [s1, s2])
  }
  const unlink = (x, y) => {
    const pair = links.get(repos.indexOf(x) + '-' + repos.indexOf(y))
    if (pair) for (const s of pair) s.destroy()
  }
  link(founder, b)
  link(founder, hub)
  link(b, hub)
  const live = [founder, b, hub]
  const settle = async () => {
    for (let i = 0; i < 25; i++) {
      for (const r of live) await r.update()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  await founder.addWriter(b.writerKey, { handle: 'b1' })
  await founder.addWriter(hub.writerKey, { indexer: true, handle: 'hub' })
  await settle()
  t.is((await b.indexers()).length, 2, 'two indexers: the founder and the hub')

  // the hub dies: b's land is seen by the founder but can never be acked by the hub
  unlink(founder, hub)
  unlink(b, hub)
  live.splice(2, 1)
  const wb = await b.workspace('wb')
  await wb.commit([put('/x', 'x')])
  const seq = (await wb.land({ message: 'after the hub died' })).outcome.seq
  await settle()
  await founder.ack()
  await settle()
  t.ok((await b.settledSeq()) < seq, 'stalled: the dead hub never acks')

  const res = await founder.removeWriter(hub.writerKey)
  t.is(res.outcome.status, 'accepted', res.outcome.reason)
  await settle()
  t.alike(await b.indexers(), [founder.writerKey], 'the founder is the only indexer now')
  t.ok((await b.settledSeq()) >= seq, 'settlement resumed without the hub')
  t.ok((await b.writer(hub.writerKey)).removed, 'the hub is recorded as removed')

  // guards: the last indexer and the bootstrap writer stay
  const last = await founder.removeWriter(founder.writerKey)
  t.is(last.outcome.status, 'invalid')
  t.ok(/bootstrap writer|last indexer/.test(last.outcome.reason), last.outcome.reason)

  // the old hub comes back with a land it made while cut off: it never reaches main, and
  // b's settled land keeps its number
  const wh = await hub.workspace('wh')
  await wh.commit([put('/ghost', 'from the removed hub')])
  await wh.land({ message: 'ghost' })
  link(b, hub)
  live.push(hub)
  await settle()
  const drive = b.drive()
  t.absent(await drive.entry('/ghost'), "the removed hub's land never reaches main")
  await drive.close()
  t.is((await b.changeset(seq)).message, 'after the hub died', 'the settled land kept its number')
})

test('light bootstrap: a solo repo settles, the last hub can go, the owner only while a hub stays', async (t) => {
  // owner: the repo's light bootstrap writer (new repos); hub: its indexer; b: an agent
  const repos = []
  for (let i = 0; i < 3; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : repos[0].key, bootstrapWeight: 1 })
    await repo.ready()
    repos.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  const [owner, hub, b] = repos
  const live = [owner]
  const settle = async () => {
    for (let i = 0; i < 25; i++) {
      for (const r of live) await r.update()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  const links = []
  const link = (x, y) => {
    const s1 = x.store.replicate(true)
    const s2 = y.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    links.push({ x, y, s: [s1, s2] })
  }
  const unlinkAll = (r) => {
    for (const l of links) if (l.x === r || l.y === r) for (const s of l.s) s.destroy()
  }

  // solo: no indexers, so settlement waits for every writer, which is just the owner
  t.alike(await owner.indexers(), [], 'a light bootstrap is not an indexer')
  const wo = await owner.workspace('wo')
  await wo.commit([put('/solo', 'solo')])
  const solo = (await wo.land()).outcome.seq
  await owner.ack()
  await settle()
  t.ok((await owner.settledSeq()) >= solo, 'a solo repo settles on its own ack')

  // the owner can't be removed while there is no hub
  const early = await owner.removeWriter(owner.writerKey)
  t.is(early.outcome.status, 'invalid')
  t.ok(/indexer \(a hub\) remains/.test(early.outcome.reason), early.outcome.reason)

  // a hub (indexer) and an agent join
  link(owner, hub)
  link(owner, b)
  link(hub, b)
  live.push(hub, b)
  await owner.addWriter(hub.writerKey, { indexer: true, handle: 'hub' })
  await owner.addWriter(b.writerKey, { handle: 'b1' })
  await settle()
  t.alike(await b.indexers(), [hub.writerKey], 'the hub is the only indexer')

  // the owner can leave while the hub stays
  const ownerGone = await hub.removeWriter(owner.writerKey)
  t.is(ownerGone.outcome.status, 'accepted', ownerGone.outcome.reason)
  await settle()

  // the hub dies; b removes it (the last indexer): settlement falls back to every writer (b)
  unlinkAll(hub)
  live.splice(live.indexOf(hub), 1)
  const wb = await b.workspace('wb')
  await wb.commit([put('/x', 'x')])
  const seq = (await wb.land()).outcome.seq
  await settle()
  t.ok((await b.settledSeq()) < seq, 'stalled on the dead hub')
  const res = await b.removeWriter(hub.writerKey)
  t.is(res.outcome.status, 'accepted', res.outcome.reason)
  await b.ack()
  await settle()
  t.alike(await b.indexers(), [], 'no indexers left')
  t.alike(await b.settlers(), [b.writerKey], 'settlement waits for every writer: b')
  t.ok((await b.settledSeq()) >= seq, 'settled again without any hub')
})
