// Run with `bare lib/schema/build.js` after changing definitions. Append-only: never edit
// existing fields, only add new optional ones.
const Hyperschema = require('hyperschema')
const path = require('bare-path')

const SPEC = path.join(__dirname, 'spec')

const schema = Hyperschema.from(SPEC)
const hs = schema.namespace('hs')

hs.register({
  name: 'head',
  fields: [
    { name: 'key', type: 'fixed32', required: true },
    { name: 'length', type: 'uint', required: true }
  ]
})

// a land's base on main: seq of the last accepted land seen, and its chain hash
hs.register({
  name: 'base',
  fields: [
    { name: 'seq', type: 'uint', required: true },
    { name: 'hash', type: 'fixed32', required: true }
  ]
})

// value is a hyperdrive entry encoding, null means delete
hs.register({
  name: 'entry',
  fields: [
    { name: 'path', type: 'string', required: true },
    { name: 'value', type: 'buffer' }
  ]
})

hs.register({
  name: 'land',
  fields: [
    { name: 'ws', type: '@hs/head', required: true },
    { name: 'base', type: '@hs/base', required: true },
    { name: 'entries', type: '@hs/entry', array: true },
    { name: 'message', type: 'string' },
    { name: 'author', type: 'string' },
    { name: 'time', type: 'uint' },
    // workspace blobs core, so mirrors can fetch landed content eagerly
    { name: 'blobs', type: 'fixed32' },
    // Ask: land an approved proposal (its id)
    { name: 'proposal', type: 'uint' },
    // Show: handles asked to review this changeset after it lands
    { name: 'reviewers', type: 'string', array: true },
    // content of /.hsreview when the land changes it, verified against the entry's hash, so
    // apply can enforce review policy without fetching blobs
    { name: 'policy', type: 'string' }
  ]
})

hs.register({
  name: 'add-writer',
  fields: [
    { name: 'key', type: 'fixed32', required: true },
    { name: 'indexer', type: 'bool' },
    // short name teammates use for this writer (reviewers, owners); unique per repo
    { name: 'handle', type: 'string' }
  ]
})

// Ask: publish a workspace's changes for review without landing them
hs.register({
  name: 'propose',
  fields: [
    { name: 'ws', type: '@hs/head', required: true },
    { name: 'base', type: '@hs/base', required: true },
    { name: 'entries', type: '@hs/entry', array: true },
    { name: 'message', type: 'string' },
    { name: 'author', type: 'string' },
    { name: 'time', type: 'uint' },
    { name: 'blobs', type: 'fixed32' },
    { name: 'reviewers', type: 'string', array: true },
    { name: 'quorum', type: 'uint' },
    // update an existing proposal (new revision, approvals reset)
    { name: 'replaces', type: 'uint' },
    { name: 'policy', type: 'string' }
  ]
})

// a review of a proposal (by id, pinned to its content hash) or of a landed changeset (Show)
hs.register({
  name: 'review',
  fields: [
    { name: 'proposal', type: 'uint' },
    { name: 'seq', type: 'uint' },
    { name: 'verdict', type: 'uint', required: true },
    { name: 'hash', type: 'fixed32' },
    { name: 'comment', type: 'string' },
    { name: 'time', type: 'uint' }
  ]
})

hs.register({
  name: 'op',
  fields: [
    { name: 'type', type: 'uint', required: true },
    { name: 'land', type: '@hs/land' },
    { name: 'addWriter', type: '@hs/add-writer' },
    { name: 'propose', type: '@hs/propose' },
    { name: 'review', type: '@hs/review' }
  ]
})

// main state: last accepted land seq and chain hash
hs.register({
  name: 'meta',
  fields: [
    { name: 'seq', type: 'uint', required: true },
    { name: 'hash', type: 'fixed32', required: true },
    // counters for proposal ids and the review event log
    { name: 'proposals', type: 'uint' },
    { name: 'events', type: 'uint' }
  ]
})

// x/cs/<seq>: an accepted changeset
hs.register({
  name: 'changeset',
  fields: [
    { name: 'seq', type: 'uint', required: true },
    { name: 'hash', type: 'fixed32', required: true },
    { name: 'writer', type: 'fixed32', required: true },
    { name: 'node', type: 'uint', required: true },
    { name: 'ws', type: '@hs/head', required: true },
    { name: 'base', type: '@hs/base', required: true },
    { name: 'paths', type: 'uint' },
    { name: 'message', type: 'string' },
    { name: 'author', type: 'string' },
    { name: 'time', type: 'uint' },
    { name: 'blobs', type: 'fixed32' },
    // the first FILES_LISTED paths of the changeset, with '-' prefix for deletes (log --files)
    { name: 'files', type: 'string', array: true },
    // the approved proposal this changeset landed, if any
    { name: 'proposal', type: 'uint' }
  ]
})

// x/ops/<writer><node>: the outcome of any op, so a writer can learn what happened to its land
hs.register({
  name: 'outcome',
  fields: [
    { name: 'status', type: 'uint', required: true },
    { name: 'seq', type: 'uint' },
    { name: 'conflicts', type: 'string', array: true },
    { name: 'reason', type: 'string' },
    { name: 'proposal', type: 'uint' }
  ]
})

// hs-writer/<key>: a writer's handle (hs-handle/<handle> maps back to the key)
hs.register({
  name: 'writer',
  fields: [{ name: 'handle', type: 'string', required: true }]
})

// hs-prop/<id>: a proposal (Ask) and its review state
hs.register({
  name: 'proposal',
  fields: [
    { name: 'id', type: 'uint', required: true },
    { name: 'author', type: 'fixed32', required: true },
    { name: 'ws', type: '@hs/head', required: true },
    { name: 'base', type: '@hs/base', required: true },
    { name: 'entries', type: '@hs/entry', array: true },
    { name: 'hash', type: 'fixed32', required: true },
    { name: 'message', type: 'string' },
    { name: 'time', type: 'uint' },
    { name: 'blobs', type: 'fixed32' },
    { name: 'reviewers', type: 'fixed32', array: true },
    { name: 'quorum', type: 'uint' },
    { name: 'revision', type: 'uint' },
    // 0 open, 1 approved, 2 landed
    { name: 'status', type: 'uint' },
    { name: 'approvals', type: 'uint' },
    { name: 'landed', type: 'uint' },
    { name: 'policy', type: 'string' }
  ]
})

// hs-rev/<target>/<writer>: a writer's latest review of a proposal or changeset
hs.register({
  name: 'review-record',
  fields: [
    { name: 'writer', type: 'fixed32', required: true },
    { name: 'verdict', type: 'uint', required: true },
    { name: 'hash', type: 'fixed32' },
    { name: 'comment', type: 'string' },
    { name: 'time', type: 'uint' }
  ]
})

// hs-req/<seq>: reviewers asked to look at a landed changeset (Show)
hs.register({
  name: 'request',
  fields: [
    { name: 'author', type: 'fixed32', required: true },
    { name: 'reviewers', type: 'fixed32', array: true }
  ]
})

// hs-ev/<n>: ordered log of review activity, streamed by hs watch
hs.register({
  name: 'event',
  fields: [
    { name: 'n', type: 'uint', required: true },
    { name: 'type', type: 'string', required: true },
    { name: 'actor', type: 'fixed32', required: true },
    { name: 'proposal', type: 'uint' },
    { name: 'seq', type: 'uint' },
    { name: 'verdict', type: 'uint' },
    { name: 'comment', type: 'string' },
    { name: 'reviewers', type: 'fixed32', array: true },
    { name: 'time', type: 'uint' }
  ]
})

// hs-policy: the review rules from /.hsreview currently in force
hs.register({
  name: 'policy',
  fields: [{ name: 'text', type: 'string' }]
})

// hs-hist/<path>/<seq>: the entry before and after that changeset (hyperdrive entry buffers,
// null = absent), so `hs show` can diff a changeset without replaying history
hs.register({
  name: 'hist',
  fields: [
    { name: 'prev', type: 'buffer' },
    { name: 'next', type: 'buffer' }
  ]
})

// x/paths/<path>: last land that touched a path
hs.register({
  name: 'path',
  fields: [{ name: 'seq', type: 'uint', required: true }]
})

// local workspace state, kept in the local writer core's user data
hs.register({
  name: 'workspace',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'tree', type: 'fixed32', required: true },
    { name: 'blobs', type: 'fixed32', required: true },
    { name: 'base', type: '@hs/base', required: true },
    { name: 'fork', type: '@hs/head', required: true },
    { name: 'landed', type: '@hs/head' },
    // current tree root; may be in main's view core (after a fork or sync) or our tree core
    { name: 'head', type: '@hs/head' },
    // the last land (writer oplog node) and the workspace state just before it, so that if a
    // reorg later flips the land to rejected the changes can be restored and rebased
    { name: 'landNode', type: '@hs/head' },
    { name: 'preLandHead', type: '@hs/head' },
    { name: 'preLandFork', type: '@hs/head' },
    { name: 'preLandBase', type: '@hs/base' },
    // this workspace's open proposal (Ask), landed with it once approved
    { name: 'proposal', type: 'uint' }
  ]
})

Hyperschema.toDisk(schema)
