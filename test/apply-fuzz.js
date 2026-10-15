// apply must be total: whatever a writer appends, it records an outcome and never throws
// (a throw in apply closes the autobee).
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const tmp = require('test-tmp')
const driveEntry = require('hyperdrive/lib/encoding')
const { getEncoding } = require('../lib/schema/spec')
const keys = require('../lib/keys')
const { apply, OP_LAND, OP_ADD_WRITER, OP_PROPOSE, OP_REVIEW, STATUS } = require('../lib/apply')

const Op = getEncoding('@hs/op')
const Outcome = getEncoding('@hs/outcome')
const Meta = getEncoding('@hs/meta')

const WRITER = crypto.randomBytes(32)
const host = { addWriter() {}, removeWriter() {} }

test('apply never throws on hostile input', async (t) => {
  const store = new Corestore(await tmp(t))
  t.teardown(() => store.close())
  const view = new Hyperbee(store)
  await view.ready()

  let length = 0
  const run = async (value) => {
    const node = { key: WRITER, length: ++length, value }
    await apply([node], view, host)
    const res = await view.get(keys.op(WRITER, length))
    return res ? STATUS[c.decode(Outcome, res.value).status] : null
  }

  const goodEntry = (path) => ({ path, value: entry(crypto.randomBytes(32)) })
  const genesis = { seq: 0, hash: keys.ZERO }
  const land = (l) =>
    c.encode(Op, { type: OP_LAND, land: { ws: { key: WRITER, length: 1 }, ...l } })
  const propose = (p) =>
    c.encode(Op, { type: OP_PROPOSE, propose: { ws: { key: WRITER, length: 1 }, ...p } })
  const review = (r) => c.encode(Op, { type: OP_REVIEW, review: r })

  const cases = [
    ['empty buffer', b4a.alloc(0)],
    ['random bytes', crypto.randomBytes(64)],
    ['truncated op', land({ base: genesis, entries: [goodEntry('/a')] }).subarray(0, 10)],
    ['unknown type', c.encode(Op, { type: 99 })],
    ['land without body', c.encode(Op, { type: OP_LAND })],
    ['add-writer without body', c.encode(Op, { type: OP_ADD_WRITER })],
    ['empty land', land({ base: genesis, entries: [] })],
    ['root path', land({ base: genesis, entries: [goodEntry('/')] })],
    ['empty path', land({ base: genesis, entries: [goodEntry('')] })],
    ['relative path', land({ base: genesis, entries: [goodEntry('a/b')] })],
    ['dot-dot path', land({ base: genesis, entries: [goodEntry('/a/../b')] })],
    ['trailing slash', land({ base: genesis, entries: [goodEntry('/a/')] })],
    ['duplicate path', land({ base: genesis, entries: [goodEntry('/a'), goodEntry('/a')] })],
    [
      'garbage entry value',
      land({ base: genesis, entries: [{ path: '/a', value: crypto.randomBytes(7) }] })
    ],
    ['blob without core', land({ base: genesis, entries: [{ path: '/a', value: entry(null) }] })],
    ['future base', land({ base: { seq: 10, hash: keys.ZERO }, entries: [goodEntry('/a')] })],
    [
      'forged base hash',
      land({ base: { seq: 0, hash: crypto.randomBytes(32) }, entries: [goodEntry('/a')] })
    ],
    [
      'land of an unknown proposal',
      land({ base: genesis, entries: [goodEntry('/a')], proposal: 7 })
    ],
    ['policy change without its text', land({ base: genesis, entries: [goodEntry('/.hsreview')] })],
    [
      'policy change with the wrong text',
      land({ base: genesis, entries: [goodEntry('/.hsreview')], policy: 'src/* approvals=1' })
    ],
    ['propose without body', c.encode(Op, { type: OP_PROPOSE })],
    ['empty proposal', propose({ base: genesis, entries: [] })],
    ['proposal with a bad path', propose({ base: genesis, entries: [goodEntry('a/../b')] })],
    [
      'proposal with an unknown reviewer',
      propose({ base: genesis, entries: [goodEntry('/a')], reviewers: ['ghost'] })
    ],
    [
      'proposal with a junk reviewer handle',
      propose({ base: genesis, entries: [goodEntry('/a')], reviewers: ['../../x', ''] })
    ],
    [
      'proposal replacing nothing',
      propose({ base: genesis, entries: [goodEntry('/a')], replaces: 99 })
    ],
    [
      'proposal on a forged base',
      propose({ base: { seq: 3, hash: crypto.randomBytes(32) }, entries: [goodEntry('/a')] })
    ],
    ['review without body', c.encode(Op, { type: OP_REVIEW })],
    ['review with a bad verdict', review({ verdict: 9, proposal: 1 })],
    ['review with no target', review({ verdict: 1 })],
    [
      'review of an unknown proposal',
      review({ verdict: 1, proposal: 42, hash: crypto.randomBytes(32) })
    ],
    ['review of an unknown changeset', review({ verdict: 3, seq: 42 })],
    [
      'add-writer with a bad handle',
      c.encode(Op, {
        type: OP_ADD_WRITER,
        addWriter: { key: crypto.randomBytes(32), handle: 'NO WAY' }
      })
    ]
  ]

  for (const [name, value] of cases) {
    let status = null
    try {
      status = await run(value)
    } catch (err) {
      t.fail(name + ' threw: ' + err.message)
      continue
    }
    t.ok(status === 'invalid' || status === 'stale-base', `${name} -> ${status}`)
  }

  t.alike(await meta(view), { seq: 0, hash: keys.ZERO }, 'nothing was accepted')

  // random mutations of valid propose and review ops
  for (const valid of [
    propose({ base: genesis, entries: [goodEntry('/p')], reviewers: ['x'], quorum: 2 }),
    review({ verdict: 1, proposal: 1, hash: crypto.randomBytes(32), comment: 'ok' })
  ]) {
    for (let i = 0; i < 150; i++) {
      const buf = b4a.from(valid)
      for (let j = 0; j < 1 + (i % 4); j++) {
        buf[Math.floor(Math.random() * buf.length)] = Math.floor(Math.random() * 256)
      }
      try {
        await run(i % 3 === 0 ? buf.subarray(0, Math.floor(Math.random() * buf.length)) : buf)
      } catch (err) {
        t.fail('mutated review op threw: ' + err.message)
        break
      }
    }
  }
  t.pass('300 mutated propose/review ops applied without throwing')

  // random mutations of a valid op
  const valid = land({ base: genesis, entries: [goodEntry('/x'), goodEntry('/y/z')] })
  for (let i = 0; i < 300; i++) {
    const buf = b4a.from(valid)
    const flips = 1 + (i % 4)
    for (let j = 0; j < flips; j++) {
      buf[Math.floor(Math.random() * buf.length)] = Math.floor(Math.random() * 256)
    }
    try {
      await run(i % 3 === 0 ? buf.subarray(0, Math.floor(Math.random() * buf.length)) : buf)
    } catch (err) {
      t.fail('mutation threw: ' + err.message)
      break
    }
  }
  t.pass('300 mutated ops applied without throwing')

  // and a valid one is still accepted afterwards
  const m = await meta(view)
  t.is(await run(land({ base: m, entries: [goodEntry('/ok.txt')] })), 'accepted')

  // a huge land is fine too
  const many = []
  for (let i = 0; i < 20_000; i++) many.push(goodEntry('/bulk/' + i))
  t.is(await run(land({ base: await meta(view), entries: many })), 'accepted', '20k-entry land')
})

function entry(core) {
  return c.encode(driveEntry, {
    executable: false,
    linkname: null,
    blob: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 1, blockMap: false, core },
    metadata: null,
    hash: crypto.randomBytes(32)
  })
}

async function meta(view) {
  const res = await view.get(keys.meta)
  return res ? c.decode(Meta, res.value) : { seq: 0, hash: keys.ZERO }
}
