// A land that is accepted locally but loses a reorg must not lose the workspace's changes.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')

const put = (path, s) => ({ path, content: b4a.from(s) })

test('provisional land flipped by a reorg is restored on sync', async (t) => {
  const { a, b, connect } = await pair(t)

  const seed = await a.workspace('seed')
  await seed.commit([put('/f.txt', 'one\ntwo\nthree\n')])
  await seed.land()
  let disconnect = connect()
  await settle(a, b)
  await disconnect()

  const wa = await a.workspace('wa')
  const wb = await b.workspace('wb')
  await wa.commit([put('/f.txt', 'ONE\ntwo\nthree\n')])
  await wb.commit([put('/f.txt', 'one\ntwo\nTHREE\n'), put('/only-b.txt', 'b\n')])

  t.is((await wa.land()).outcome.status, 'accepted')
  t.is((await wb.land()).outcome.status, 'accepted')

  disconnect = connect()
  await settle(a, b)

  const oa = await wa.lastLand()
  const ob = await wb.lastLand()
  t.comment(`after reorg: a=${oa.status} b=${ob.status}`)
  t.alike([oa.status, ob.status].sort(), ['accepted', 'conflict'])

  const loser = oa.status === 'conflict' ? wa : wb
  const res = await loser.sync()
  t.ok(res.restored, 'flipped land was detected and restored')
  t.alike(res.merged, ['/f.txt'], 'restored change rebased with a clean merge')
  t.alike(await loser.drive.get('/f.txt'), b4a.from('ONE\ntwo\nTHREE\n'))

  t.is((await loser.land()).outcome.status, 'accepted', 'loser re-lands')
  await settle(a, b)

  const main = a.drive()
  t.alike(await main.get('/f.txt'), b4a.from('ONE\ntwo\nTHREE\n'))
  t.alike(await main.get('/only-b.txt'), b4a.from('b\n'))
  await main.close()
  await disconnect()
})

test('commits made after a land that later flips are kept', async (t) => {
  const { a, b, connect } = await pair(t)

  const seed = await a.workspace('seed')
  await seed.commit([put('/f.txt', 'one\ntwo\nthree\n')])
  await seed.land()
  let disconnect = connect()
  await settle(a, b)
  await disconnect()

  const wa = await a.workspace('wa')
  const wb = await b.workspace('wb')
  await wa.commit([put('/f.txt', 'ONE\ntwo\nthree\n')])
  await wb.commit([put('/f.txt', 'one\ntwo\nTHREE\n')])
  t.is((await wa.land()).outcome.status, 'accepted')
  t.is((await wb.land()).outcome.status, 'accepted')

  // both keep working after their provisional land
  await wa.commit([put('/later-a.txt', 'a\n')])
  await wb.commit([put('/later-b.txt', 'b\n')])

  disconnect = connect()
  await settle(a, b)

  const loser = (await wa.lastLand()).status === 'conflict' ? wa : wb
  const later = loser === wa ? '/later-a.txt' : '/later-b.txt'

  const res = await loser.sync()
  t.ok(res.restored, 'flip detected')
  t.alike(await loser.drive.get('/f.txt'), b4a.from('ONE\ntwo\nTHREE\n'), 'flipped change merged')
  t.ok(await loser.drive.entry(later), 'later commit survived')

  t.is((await loser.land()).outcome.status, 'accepted')
  await settle(a, b)
  const main = b.drive()
  t.alike(await main.get('/f.txt'), b4a.from('ONE\ntwo\nTHREE\n'))
  t.ok(await main.entry(later), 'later commit landed')
  await main.close()
  await disconnect()
})

async function pair(t) {
  const sa = new Corestore(await tmp(t))
  const sb = new Corestore(await tmp(t))
  const a = new Repo(sa)
  await a.ready()
  const b = new Repo(sb, { key: a.key })
  await b.ready()

  t.teardown(async () => {
    await a.close()
    await b.close()
    await sa.close()
    await sb.close()
  })

  const connect = () => {
    const s1 = sa.replicate(true)
    const s2 = sb.replicate(false)
    s1.pipe(s2).pipe(s1)
    return async () => {
      s1.destroy()
      s2.destroy()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const disconnect = connect()
  await a.addWriter(b.writerKey, { indexer: true })
  await settle(a, b)
  t.ok(b.writable)
  await disconnect()

  return { a, b, connect }
}

// update until every repo agrees on main's head for a few consecutive polls
async function settle(...repos) {
  let last = null
  let stable = 0
  for (let i = 0; i < 200 && stable < 3; i++) {
    for (const r of repos) await r.update()
    const metas = await Promise.all(repos.map((r) => r.meta()))
    const id = metas.map((m) => m.seq + ':' + b4a.toString(m.hash, 'hex')).join(',')
    const same = metas.every((m) => b4a.equals(m.hash, metas[0].hash))
    stable = same && id === last ? stable + 1 : 0
    last = id
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
