// Claims (docs/CLAIMS.md), phase 1: items and claims as records in main, the board that
// merges them with signals, the lead rule, and signal signatures.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const claims = require('../lib/claims')

const put = (path, s) => ({ path, content: b4a.from(s) })

test('items and claims are records; a land completes its items', async (t) => {
  const [a, b] = await pair(t)
  const time = Date.now()
  const id = claims.itemId({ writer: a.writerKey, time, title: 'CR-1 flight minutes' })
  t.is(
    (
      await a.itemOp({
        item: id,
        action: claims.NEW,
        time,
        at: time,
        title: 'CR-1 flight minutes',
        paths: ['/src/pricing.js']
      })
    ).outcome.status,
    'accepted'
  )
  t.is(
    (await b.itemOp({ item: id, action: claims.CLAIM, time: time + 10, at: time + 10 })).outcome
      .status,
    'accepted'
  )
  await sync(a, b)

  const it = await a.item(id)
  t.is(it.title, 'CR-1 flight minutes')
  t.alike(it.paths, ['/src/pricing.js'])
  t.ok((await a.itemByPrefix(claims.shortId(id))) !== null, 'found by its short id')
  const recs = await a.claimRecords(id)
  t.is(recs.length, 1)
  t.ok(b4a.equals(recs[0].writer, b.writerKey))

  // a claim for another writer is invalid
  const forged = await a.itemOp({ item: id, action: claims.CLAIM, time, at: time })
  t.is(forged.outcome.status, 'accepted', 'own claim fine')
  const { outcome } = await a._append({
    type: 7,
    item: { item: id, action: claims.CLAIM, writer: b.writerKey, time, at: time }
  })
  t.is(outcome.status, 'invalid', 'a claim signed for another writer is rejected')

  // b lands and completes the item
  const ws = await b.workspace('w')
  await ws.commit([put('/src/pricing.js', 'per minute\n')])
  t.is((await ws.land({ message: 'CR-1', items: [id] })).outcome.status, 'accepted')
  await sync(a, b)
  const done = await a.item(id)
  t.ok(done.done > 0, 'done by changeset #' + done.done)
  t.ok(b4a.equals(done.doneBy, b.writerKey))
})

test('parts: the last part landing says so; the parent is closed by its lead', async (t) => {
  const [a, b] = await pair(t)
  const time = Date.now()
  const parent = claims.itemId({ writer: a.writerKey, time, title: 'CR-1' })
  await a.itemOp({ item: parent, action: claims.NEW, time, at: time, title: 'CR-1' })
  await a.itemOp({ item: parent, action: claims.CLAIM, time, at: time })
  const parts = []
  for (const title of ['scheduler side', 'pricing side']) {
    const id = claims.itemId({ writer: a.writerKey, time: time + parts.length + 1, title, parent })
    await a.itemOp({
      item: id,
      action: claims.NEW,
      time: time + parts.length + 1,
      at: time,
      title,
      parent
    })
    parts.push(id)
  }
  await sync(a, b)
  const ws = await b.workspace('w')
  const types = async () => (await a.events({ since: 0 })).map((e) => e.type)
  for (const [i, id] of parts.entries()) {
    await b.itemOp({ item: id, action: claims.CLAIM, time: time + 10, at: time + 10 })
    await ws.commit([put(`/part${i}.txt`, 'x')])
    t.is((await ws.land({ items: [id] })).outcome.status, 'accepted')
    await sync(a, b)
    const seen = await types()
    t.is(
      seen.includes('parts-done'),
      i === 1,
      i === 1 ? 'all parts done: said so' : 'one part left: not yet'
    )
  }
  t.is((await a.item(parent)).done, 0, 'the parent stays open (it may have work of its own)')

  // b neither made nor claimed the parent: can't close it; a, its claimant, can
  const notB = await b.itemOp({ item: parent, action: claims.DONE, time, at: Date.now() })
  t.is(notB.outcome.status, 'invalid')
  const byA = await a.itemOp({ item: parent, action: claims.DONE, time, at: Date.now() })
  t.is(byA.outcome.status, 'accepted')
  t.ok((await a.item(parent)).done > 0, 'closed by its lead')
})

test('board: the lead is the earliest claim; renewals never move it; stale claims lose it', (t) => {
  const board = new claims.Board()
  const item = b4a.alloc(32, 1)
  const w1 = b4a.alloc(32, 2)
  const w2 = b4a.alloc(32, 3)
  const now = 1_000_000
  board.add({ item, action: claims.NEW, writer: w1, time: now - 5000, title: 'x' })
  board.add({ item, action: claims.CLAIM, writer: w2, time: now - 3000, at: now - 3000 })
  board.add({ item, action: claims.CLAIM, writer: w1, time: now - 2000, at: now - 2000 })
  t.ok(b4a.equals(board.lead(item, now).lead.writer, w2), 'earliest claim leads')
  // w1 renews later: still w2
  board.add({ item, action: claims.HEARTBEAT, writer: w1, time: now - 2000, at: now - 100 })
  t.ok(b4a.equals(board.lead(item, now).lead.writer, w2), 'a renewal does not move the lead')
  // w2's claim goes stale (no renewal for its TTL): w1 leads
  const later = now - 3000 + claims.TTL_MS + 1
  t.ok(b4a.equals(board.lead(item, later).lead.writer, w1), 'a stale claim loses the lead')
  t.is(board.claimsOn(item, later).find((cl) => b4a.equals(cl.payload.writer, w2)).state, 'stale')
  // a heartbeat with no claim before it creates nothing
  const w3 = b4a.alloc(32, 4)
  board.add({ item, action: claims.HEARTBEAT, writer: w3, time: now - 9000, at: now })
  t.is(board.claimsOn(item, now).length, 2, 'a stray heartbeat is not a claim')
  // order of arrival doesn't matter
  const other = new claims.Board()
  other.add({ item, action: claims.CLAIM, writer: w1, time: now - 2000, at: now - 2000 })
  other.add({ item, action: claims.CLAIM, writer: w2, time: now - 3000, at: now - 3000 })
  t.ok(b4a.equals(other.lead(item, now).lead.writer, w2), 'same lead whatever the arrival order')
  // asking to share (--with the lead) makes a co-lead, as the lead naming you does
  const shared = new claims.Board()
  shared.add({ item, action: claims.CLAIM, writer: w2, time: now - 3000, at: now - 3000 })
  shared.add({
    item,
    action: claims.CLAIM,
    writer: w1,
    time: now - 2000,
    at: now - 2000,
    with: [w2]
  })
  const sl = shared.lead(item, now)
  t.ok(
    b4a.equals(sl.lead.writer, w2) &&
      sl.coLeads.length === 1 &&
      b4a.equals(sl.coLeads[0].writer, w1),
    'co-lead by asking to share'
  )
  // release
  board.add({ item, action: claims.RELEASE, writer: w2, time: now - 3000, at: now })
  t.ok(b4a.equals(board.lead(item, now + 1).lead.writer, w1), 'a release hands the lead on')
  // done: no lead
  board.add({ item, action: claims.DONE, writer: w1, at: now })
  t.is(board.lead(item, now + 2), null, 'a done item has no lead')
})

test('signals are signed by the writer and checked', async (t) => {
  const [a, b] = await pair(t)
  const time = Date.now()
  const item = claims.itemId({ writer: a.writerKey, time, title: 't' })
  const signed = claims.sign(
    { item, action: claims.CLAIM, writer: a.writerKey, time, at: time },
    a.main.local.keyPair
  )
  t.ok(claims.verify(signed), 'valid')
  t.absent(claims.verify({ ...signed, at: time + 1 }), 'tampered content fails')
  t.absent(claims.verify({ ...signed, writer: b.writerKey }), 'claiming to be another writer fails')
  const roundTrip = claims.decode(claims.encode(signed))
  t.ok(claims.verify(roundTrip), 'survives encoding')
})

async function pair(t) {
  const out = []
  for (let i = 0; i < 2; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : out[0].key })
    await repo.ready()
    out.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  const [a, b] = out
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })
  await a.addWriter(b.writerKey)
  for (let i = 0; i < 50 && !b.writable; i++) await sync(a, b)
  t.ok(b.writable, 'b is a writer')
  return out
}

async function sync(...repos) {
  for (let i = 0; i < 10; i++) {
    for (const r of repos) await r.update()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
