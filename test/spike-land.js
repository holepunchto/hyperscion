// Spike C: lock-free landing through autobee. Two writers land concurrently from the
// same base; both peers must converge on identical outcomes and hash chain.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Autobee = require('autobee')
const tmp = require('test-tmp')
const driveEntry = require('hyperdrive/lib/encoding')
const { getEncoding } = require('../lib/schema/spec')
const keys = require('../lib/keys')
const { apply, OP_LAND, OP_ADD_WRITER, STATUS } = require('../lib/apply')

const Op = getEncoding('@hs/op')
const Outcome = getEncoding('@hs/outcome')
const Meta = getEncoding('@hs/meta')

const BLOBS = crypto.randomBytes(32)

test('concurrent lands converge deterministically', async (t) => {
  const { a, b, connect } = await pair(t)
  let disconnect = connect()

  // seed main with two files
  const n0 = await land(a, { seq: 0, hash: keys.ZERO }, { '/a.txt': 'a0', '/b.txt': 'b0' })
  await sync(a, b)
  t.is(await outcome(b, n0), 'accepted')

  const base = await meta(a)
  t.is(base.seq, 1)
  t.alike(await meta(b), base, 'both peers agree on chain head')

  // concurrent, offline from each other: same path conflicts, disjoint paths do not
  await disconnect()
  const na = await land(a, base, { '/a.txt': 'from-a', '/x.txt': 'x' })
  const nb = await land(b, base, { '/a.txt': 'from-b' })
  const nc = await land(b, base, { '/b.txt': 'b1' })
  t.is(await outcome(a, na), 'accepted', 'a optimistically accepts its own land')
  t.is(await outcome(b, nb), 'accepted', 'b optimistically accepts its own land')

  const undos = a.stats.undos + b.stats.undos
  disconnect = connect()
  await sync(a, b)
  t.comment(`undos during reconnect: ${a.stats.undos + b.stats.undos - undos}`)
  t.ok(a.stats.undos + b.stats.undos > undos, 'a reorg happened')

  const results = {
    a: [await outcome(a, na), await outcome(a, nb), await outcome(a, nc)],
    b: [await outcome(b, na), await outcome(b, nb), await outcome(b, nc)]
  }
  t.comment(JSON.stringify(results))
  t.alike(results.a, results.b, 'same outcomes on both peers')
  t.alike(results.a.slice(0, 2).sort(), ['accepted', 'conflict'], 'exactly one /a.txt land wins')
  t.is(results.a[2], 'accepted', 'disjoint land accepted')

  t.alike(await meta(a), await meta(b), 'same hash chain head')
  t.is((await meta(a)).seq, 3)

  t.alike(await file(a, '/b.txt'), await file(b, '/b.txt'))
  t.alike(await file(a, '/a.txt'), await file(b, '/a.txt'))

  // a forged / reorged-away base is rejected, not thrown
  const ns = await land(a, { seq: 2, hash: crypto.randomBytes(32) }, { '/z.txt': 'z' })
  t.is(await outcome(a, ns), 'stale-base')

  const nf = await land(a, { seq: 99, hash: keys.ZERO }, { '/z.txt': 'z' })
  t.is(await outcome(a, nf), 'stale-base')

  // garbage op is recorded as invalid and does not kill the db
  await a.append(b4a.from('not an op'))
  await a.update()
  t.is(await outcome(a, { key: a.local.key, length: a.local.length }), 'invalid')

  const nl = await land(a, await meta(a), { '/after.txt': 'ok' })
  t.is(await outcome(a, nl), 'accepted', 'db still healthy')
})

async function pair(t) {
  const sa = new Corestore(await tmp(t))
  const sb = new Corestore(await tmp(t))

  const a = new Autobee(sa, null, { apply, optimistic: false })
  await a.ready()
  const b = new Autobee(sb, a.key, { apply, optimistic: false })
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
  await a.append(
    c.encode(Op, { type: OP_ADD_WRITER, addWriter: { key: b.local.key, indexer: true } })
  )
  await sync(a, b)
  t.ok(b.writable, 'b was added as writer')
  await disconnect()

  return { a, b, connect }
}

async function land(db, base, files) {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    value: c.encode(driveEntry, {
      executable: false,
      linkname: null,
      blob: {
        byteOffset: 0,
        blockOffset: 0,
        blockLength: 1,
        byteLength: content.length,
        blockMap: false,
        core: BLOBS
      },
      metadata: { content },
      hash: crypto.hash(b4a.from(content))
    })
  }))

  const op = {
    type: OP_LAND,
    land: {
      ws: { key: db.local.key, length: 0 },
      base,
      entries,
      message: 'm',
      author: 't',
      time: 0
    }
  }

  await db.append(c.encode(Op, op))
  return { key: db.local.key, length: db.local.length }
}

async function sync(...dbs) {
  for (let i = 0; i < 5; i++) {
    for (const db of dbs) await db.update()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function outcome(db, node) {
  const res = await db.view.get(keys.op(node.key, node.length))
  return res ? STATUS[c.decode(Outcome, res.value).status] : null
}

async function meta(db) {
  const res = await db.view.get(keys.meta)
  return c.decode(Meta, res.value)
}

async function file(db, path) {
  const res = await db.view.get(keys.files.encode(path))
  return res ? c.decode(driveEntry, res.value).metadata : null
}
