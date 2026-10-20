// Spike A: cross-core fork. A workspace bee roots its first batch at another
// core's version; only the dirty root-to-leaf path is written locally.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const tmp = require('test-tmp')

const N = 100_000

for (const encrypted of [false, true]) {
  test(`cross-core fork writes O(depth) blocks (encrypted=${encrypted})`, async (t) => {
    const store = new Corestore(await tmp(t))
    t.teardown(() => store.close())

    const encryptionKey = encrypted ? crypto.randomBytes(32) : null
    const encryption = encryptionKey ? { key: encryptionKey } : null

    const main = new Hyperbee(store.namespace('main'), { encryption })
    await main.ready()

    let w = main.write()
    for (let i = 0; i < N; i++) {
      w.tryPut(key(i), b4a.from('v' + i))
      if (i % 10_000 === 9_999) {
        await w.flush()
        w = main.write()
      }
    }

    const base = main.head()
    t.is(base.length, main.core.length)

    const ws = new Hyperbee(store.namespace('ws'), { encryption })
    await ws.ready()
    t.is(ws.core.length, 0)

    const fork = ws.write({ key: base.key, length: base.length })
    fork.tryPut(key(4242), b4a.from('changed'))
    await fork.flush()

    const appended = ws.core.length
    t.comment(`main blocks=${main.core.length}, fork appended=${appended}`)
    t.ok(appended > 0 && appended <= 8, 'fork appends only a handful of blocks')

    t.alike((await ws.get(key(4242))).value, b4a.from('changed'))
    t.alike((await ws.get(key(77))).value, b4a.from('v77'), 'reads through to main core')
    t.alike((await ws.get(key(N - 1))).value, b4a.from('v' + (N - 1)))

    const cores = await ws.cores()
    t.ok(
      cores.some((k) => b4a.equals(k, base.key)),
      'fork references main core'
    )

    const left = main.checkout({ key: base.key, length: base.length })
    const changes = []
    for await (const d of left.createDiffStream(ws)) changes.push(d)
    t.is(changes.length, 1, 'diff yields exactly the one change')
    t.alike(changes[0].left.key, key(4242))

    // second commit on the workspace stays local and cheap
    const before = ws.core.length
    const w2 = ws.write()
    w2.tryPut(key(99_999), b4a.from('also'))
    await w2.flush()
    t.ok(ws.core.length - before <= 8)
    t.alike((await main.get(key(99_999))).value, b4a.from('v99999'), 'main untouched')
  })
}

function key(i) {
  return b4a.from('src/' + String(i).padStart(8, '0'))
}
