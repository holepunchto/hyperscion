// The repo ABI (docs/DESIGN.md "Rules versioning", after keet's room ABI): one number in main
// that says which ops a repo admits and which rules apply. Every peer judges every op by the
// repo's ABI, never by its own build, so a newer hs in a repo that hasn't upgraded computes
// exactly what an older one does.
//
// lib/schema/abi.json pins, per ABI, the highest op type it admits and the schema version its
// ops decode at (fields newer than that are dropped on every peer alike). A released row never
// changes: a new op type or field is a new row (test/abi.js keeps the table honest).
const c = require('compact-encoding')
const spec = require('./schema/spec')
const TABLE = require('./schema/abi.json')

// behaviour that differs between ABIs: name -> the first ABI with it. Apply asks
// featureAt(repoAbi, name), so old ops keep replaying under the rules they were written for
const FEATURES = {}

const MAX = TABLE[TABLE.length - 1].abi
// what `hs init` creates: can lag MAX, so a release can ship rules before switching them on
const DEFAULT = 1

function row(abi) {
  return TABLE.find((r) => r.abi === abi) || null
}

function featureAt(abi, name) {
  if (!(name in FEATURES)) throw new Error('unknown ABI feature: ' + name)
  return abi >= FEATURES[name]
}

// decode an op as the repo's ABI sees it. The generated codec keeps its version in a module
// variable that getStruct sets; put it back, or every later encode would drop newer fields
function decodeOp(buf, abi) {
  const r = row(abi)
  if (!r) throw new Error('unsupported ABI ' + abi)
  try {
    return c.decode(spec.getStruct('@hs/op', r.schemaVersion), buf)
  } finally {
    spec.setVersion(spec.version)
  }
}

module.exports = { TABLE, FEATURES, MAX, DEFAULT, row, featureAt, decodeOp }
