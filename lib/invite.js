// The invite another peer joins with (decided 2026-11-24): a versioned, schema-encoded bearer
// invite, z32 like keet's. `kind` 1 carries the read keys, so it works like a password: anyone
// holding it can replicate and read the repo. Keyless invites (keet's mailbox model: the keys
// sealed to a joiner that every peer's apply admitted) can come later as another kind without
// breaking this one. The repo's rule inputs live in its genesis op; bootstrapWeight is here
// only because autobee needs it before apply runs (Repo#checkGenesis compares the two).
const c = require('compact-encoding')
const z32 = require('z32')
const { getEncoding } = require('./schema/spec')

const Invite = getEncoding('@hs/invite')
const BEARER = 1

function encode({ key, encryptionKey = null, bootstrapWeight = 2 }) {
  return z32.encode(
    c.encode(Invite, { kind: BEARER, key, encryptionKey: encryptionKey || null, bootstrapWeight })
  )
}

function decode(str) {
  let inv = null
  try {
    inv = c.decode(Invite, z32.decode(String(str).trim()))
  } catch {}
  if (!inv || !inv.key) {
    throw new Error('not an hs invite (`hs info` in a worktree of the repo prints one)')
  }
  if (inv.kind !== BEARER) {
    throw new Error(`this invite is of a kind this hs doesn't know (${inv.kind}): update hs`)
  }
  return {
    key: inv.key,
    encryptionKey: inv.encryptionKey || null,
    bootstrapWeight: inv.bootstrapWeight === 1 ? 1 : 2
  }
}

module.exports = { encode, decode, BEARER }
