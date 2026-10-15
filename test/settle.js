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
