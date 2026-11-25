// The repo ABI table (lib/abi.js, lib/schema/abi.json) stays honest: a new op type or a schema
// change needs a new row (or, before the first release, an updated one), and ops past a repo's
// ABI are judged the same by every build.
const test = require('brittle')
const c = require('compact-encoding')
const spec = require('../lib/schema/spec')
const abi = require('../lib/abi')
const apply = require('../lib/apply')

const OP_TYPES = Object.entries(apply)
  .filter(([k, v]) => k.startsWith('OP_') && typeof v === 'number')
  .map(([, v]) => v)

test('abi table: rows are contiguous and only grow', (t) => {
  abi.TABLE.forEach((r, i) => {
    t.is(r.abi, i + 1, `row ${i} is ABI ${i + 1}`)
    if (i > 0) {
      t.ok(r.maxOpId >= abi.TABLE[i - 1].maxOpId, 'maxOpId never shrinks')
      t.ok(r.schemaVersion >= abi.TABLE[i - 1].schemaVersion, 'schemaVersion never shrinks')
    }
  })
  t.is(abi.MAX, abi.TABLE.length)
  t.ok(abi.DEFAULT >= 1 && abi.DEFAULT <= abi.MAX, 'new repos start at a supported ABI')
})

test('abi table: the newest row matches the code', (t) => {
  const last = abi.TABLE[abi.TABLE.length - 1]
  t.is(
    last.schemaVersion,
    spec.version,
    'a schema change needs a new ABI row (lib/schema/abi.json schemaVersion)'
  )
  t.is(
    last.maxOpId,
    Math.max(...OP_TYPES),
    'a new op type needs a new ABI row (lib/schema/abi.json maxOpId)'
  )
  for (const name of Object.keys(abi.FEATURES)) {
    t.ok(abi.FEATURES[name] >= 1 && abi.FEATURES[name] <= abi.MAX, `feature ${name} has an ABI`)
  }
})

test('decodeOp leaves the codec at the current schema version', (t) => {
  const Op = spec.getEncoding('@hs/op')
  const buf = c.encode(Op, { type: apply.OP_ACK })
  const op = abi.decodeOp(buf, 1)
  t.is(op.type, apply.OP_ACK)
  // an encode after a decode at an older version still writes every field
  const again = c.decode(Op, c.encode(Op, { type: apply.OP_ACK }))
  t.is(again.type, apply.OP_ACK)
  t.exception(() => abi.decodeOp(buf, abi.MAX + 1), /unsupported ABI/)
  t.exception(() => abi.featureAt(1, 'no-such-feature'), /unknown ABI feature/)
})
