// Spike (pre-release plan A1.5): an old peer that meets a repo ABI it doesn't support calls
// host.interrupt and stops. Autobee's interrupt flag never clears, so recovery is a fresh
// instance over the same store, running newer code. keet's version of this test is skipped as
// broken ("restart re-applies genesis"); this checks autobee 2.13 at the raw level before hs
// builds on it.
//
// Findings (2026-11-24, autobee 2.13.6):
// - interrupted by a remote op, a fresh instance with newer code catches up exactly
// - an append on an interrupted instance resolves but writes nothing (the local core doesn't
//   grow): hs must refuse to write once interrupted, and check that an append really landed
// The local-op cases below pin that behaviour, so a change in autobee shows up here.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Autobee = require('autobee')
const tmp = require('test-tmp')

// an op is JSON { abi, k, v }; the view keeps k -> v and the repo's abi under 'abi'. A build
// supports ABIs up to `max`; an op raising the repo past it interrupts before anything is written
function makeApply(max, seen) {
  return async (nodes, view, host) => {
    for (const node of nodes) {
      const op = JSON.parse(b4a.toString(node.value))
      const cur = await view.get(b4a.from('abi'))
      const abi = cur ? Number(b4a.toString(cur.value)) : 1
      const next = Math.max(abi, op.abi || 1)
      if (next > max) {
        seen.interrupts++
        host.interrupt({ unsupportedAbi: next })
      }
      if (op.add) await host.addWriter(b4a.from(op.add, 'hex'), { isIndexer: false })
      const w = view.write()
      if (next !== abi) w.tryPut(b4a.from('abi'), b4a.from(String(next)))
      w.tryPut(b4a.from(op.k), b4a.from(op.v))
      await w.flush()
    }
  }
}

async function open(store, key, max) {
  const seen = { interrupts: 0, events: [] }
  const db = new Autobee(store, key, { apply: makeApply(max, seen), optimistic: false })
  db.on('interrupt', (why) => seen.events.push(why))
  await db.ready()
  return { db, seen }
}

const op = (abi, k, v) => b4a.from(JSON.stringify({ abi, k, v }))
const get = async (db, k) => {
  const node = await db.view.get(b4a.from(k))
  return node ? b4a.toString(node.value) : null
}

test('a local op past the build ABI interrupts, and autobee drops it', async (t) => {
  const dir = await tmp(t)
  let store = new Corestore(dir)
  let { db, seen } = await open(store, null, 1)
  const key = db.key

  await db.append(op(1, 'a', 'one'))
  await db.append(op(2, 'b', 'two')) // the repo moves to ABI 2: this build supports 1
  await db.append(op(2, 'c', 'three'))
  await db.update().catch(() => {})
  t.ok(seen.events.length >= 1, 'interrupted: ' + JSON.stringify(seen.events))
  t.alike(seen.events[0], { unsupportedAbi: 2 })
  t.is(await get(db, 'a'), 'one', 'ops before the upgrade applied')
  t.is(await get(db, 'b'), null, 'nothing from the unsupported op was written')

  // b raised the ABI past this build: autobee dropped b and c rather than writing them
  t.is(db.local.length, 1, 'appends on an interrupted instance are dropped, not written')
  await db.close()
  await store.close()

  // the same store, a build that knows ABI 2
  store = new Corestore(dir)
  ;({ db, seen } = await open(store, key, 2))
  t.teardown(async () => {
    await db.close()
    await store.close()
  })
  t.is(db.local.length, 1, 'nothing to recover: they never reached the local core')
  await db.update()
  t.is(seen.events.length, 0, 'no interrupt with newer code')
  t.is(await get(db, 'a'), 'one')
  t.is(await get(db, 'b'), null, 'the dropped op is gone')
  t.is(await get(db, 'c'), null)
  await db.append(op(2, 'd', 'four'))
  await db.update()
  t.is(await get(db, 'd'), 'four', 'and it keeps going')
})

test('interrupt on the very first op (genesis), then reopen', async (t) => {
  const dir = await tmp(t)
  let store = new Corestore(dir)
  let { db, seen } = await open(store, null, 1)
  const key = db.key
  await db.append(op(2, 'g', 'genesis'))
  await db.update().catch(() => {})
  t.ok(seen.events.length >= 1, 'interrupted at genesis')
  t.is(await get(db, 'g'), null)
  await db.close()
  await store.close()

  store = new Corestore(dir)
  ;({ db, seen } = await open(store, key, 2))
  t.teardown(async () => {
    await db.close()
    await store.close()
  })
  await db.update()
  t.is(seen.events.length, 0)
  t.is(await get(db, 'g'), null, 'dropped like any append on an interrupted instance')
  await db.append(op(2, 'h', 'after'))
  await db.update()
  t.is(await get(db, 'h'), 'after', 'a reopened repo works from its first op')
})

test('a replicating peer interrupts, reopens with newer code and catches up', async (t) => {
  const sa = new Corestore(await tmp(t))
  const bdir = await tmp(t)
  let sb = new Corestore(bdir)
  const a = (await open(sa, null, 2)).db
  let { db: b, seen } = await open(sb, a.key, 1)
  t.teardown(async () => {
    await a.close()
    await sa.close()
  })

  let link = connect(sa, sb)
  await a.append(op(1, 'x', '1'))
  await a.append(op(2, 'y', '2'))
  for (let i = 0; i < 100 && !seen.events.length; i++) {
    await b.update().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.ok(seen.events.length >= 1, 'the old peer stopped')
  t.is(await get(b, 'x'), '1')
  t.is(await get(b, 'y'), null)
  link()
  await b.close()
  await sb.close()

  sb = new Corestore(bdir)
  ;({ db: b, seen } = await open(sb, a.key, 2))
  t.teardown(async () => {
    await b.close()
    await sb.close()
  })
  link = connect(sa, sb)
  t.teardown(() => link())
  for (let i = 0; i < 100 && (await get(b, 'y')) === null; i++) {
    await b.update()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.is(await get(b, 'y'), '2', 'caught up after the update')
  t.is(seen.events.length, 0)
  const ha = a.view.head()
  const hb = b.view.head()
  t.ok(ha && hb, 'both have a view head')
})

function connect(sa, sb) {
  const s1 = sa.replicate(true)
  const s2 = sb.replicate(false)
  s1.pipe(s2).pipe(s1)
  return () => {
    s1.destroy()
    s2.destroy()
  }
}

test('realistic: interrupted by a teammate, then a local append, then reopen', async (t) => {
  const sa = new Corestore(await tmp(t))
  const bdir = await tmp(t)
  let sb = new Corestore(bdir)
  const a = (await open(sa, null, 2)).db
  t.teardown(async () => {
    await a.close()
    await sa.close()
  })
  // b must be a writer for its local op to count
  let { db: b, seen } = await open(sb, a.key, 1)
  let link = connect(sa, sb)
  await a.append(addWriter(b.local.key))
  for (let i = 0; i < 100 && !b.writable; i++) {
    await b.update().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.ok(b.writable, 'b is a writer')
  await a.append(op(2, 'up', 'grade')) // a teammate upgrades the repo
  for (let i = 0; i < 100 && !seen.events.length; i++) {
    await b.update().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.ok(seen.events.length >= 1, 'b stopped on the upgrade')
  const before = b.local.length
  let appendErr = null
  await b.append(op(1, 'mine', 'local')).catch((err) => (appendErr = err))
  t.absent(appendErr, 'append on an interrupted instance resolves...')
  t.is(b.local.length, before, '...but writes nothing: hs must refuse to write when interrupted')
  link()
  await b.close()
  await sb.close()

  sb = new Corestore(bdir)
  ;({ db: b, seen } = await open(sb, a.key, 2))
  t.teardown(async () => {
    await b.close()
    await sb.close()
  })
  link = connect(sa, sb)
  t.teardown(() => link())
  for (let i = 0; i < 100 && (await get(b, 'up')) === null; i++) {
    await b.update()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  t.is(await get(b, 'up'), 'grade', 'b caught up with the upgrade')
  t.is(await get(b, 'mine'), null, 'the op appended while interrupted is lost')
  await b.append(op(1, 'mine', 'again'))
  await b.update()
  t.is(await get(b, 'mine'), 'again', 'appends work again after reopening')
})

function addWriter(key) {
  return b4a.from(JSON.stringify({ abi: 1, k: 'w', v: 'x', add: b4a.toString(key, 'hex') }))
}
