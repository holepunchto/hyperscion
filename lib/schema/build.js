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

// the text of a file /.hsreview protects, carried inline (as the policy is) so apply can tell
// which lines a change adds or removes without fetching blobs (TO-FIVE #17)
hs.register({
  name: 'text',
  fields: [
    { name: 'path', type: 'string', required: true },
    { name: 'text', type: 'string' }
  ]
})

// the lines a proposal adds to and removes from a protected file, against main when proposed
// (sorted multisets): an approval binds to these, so teammates' approved sections merging into
// the same file don't reset it
hs.register({
  name: 'hunk',
  fields: [
    { name: 'path', type: 'string', required: true },
    { name: 'added', type: 'string', array: true },
    { name: 'removed', type: 'string', array: true }
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
    { name: 'policy', type: 'string' },
    // the blobs core's length at land time, plus one (0: not recorded, older writers). A
    // mirror holds the blobs up to here; the core's current length moves with later commits
    { name: 'blobsLength', type: 'uint' },
    // items this land completes (docs/CLAIMS.md): apply marks them done when it is accepted,
    // and a reorg that flips the land reopens them on replay
    { name: 'items', type: 'fixed32', array: true },
    // approved items this land works under without completing them (phase 2: an approved plan
    // covers its protected paths for several lands)
    { name: 'under', type: 'fixed32', array: true },
    // the text of each changed file /.hsreview protects, verified against its entry's hash
    { name: 'texts', type: '@hs/text', array: true },
    // and main's text of those files, for when apply doesn't know it yet (last changed before
    // the policy protected them), verified against main's entry
    { name: 'mains', type: '@hs/text', array: true }
  ]
})

hs.register({
  name: 'add-writer',
  fields: [
    { name: 'key', type: 'fixed32', required: true },
    { name: 'indexer', type: 'bool' },
    // short name teammates use for this writer (reviewers, owners); unique per repo
    { name: 'handle', type: 'string' },
    // a person, not an agent (only the bootstrap writer, the team owner, can say so): policy
    // can then ask `@humans` to approve (docs/CLAIMS.md, phase 2)
    { name: 'human', type: 'bool' },
    // new: the team owner (only the genesis writer can say so; docs/FINALITY.md)
    { name: 'owner', type: 'bool' }
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
    { name: 'policy', type: 'string' },
    // as in land: blobs core length plus one, 0 if not recorded
    { name: 'blobsLength', type: 'uint' },
    // as in land: the text of each protected file it changes, and main's
    { name: 'texts', type: '@hs/text', array: true },
    { name: 'mains', type: '@hs/text', array: true }
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
    { name: 'time', type: 'uint' },
    // or an item (claims phase 2): approvals pin the item's hash (title, kind, paths)
    { name: 'item', type: 'fixed32' }
  ]
})

// type 6: take a writer out of the repo (a hub that is gone for good, a lost key). Its
// unseen ops are dropped; if it was an indexer, settlement stops waiting for it
hs.register({
  name: 'remove-writer',
  fields: [{ name: 'key', type: 'fixed32', required: true }]
})

// type 7 (claims, docs/CLAIMS.md): an item (a change request, a suggestion, a part) or a
// claim on one. The same signed payload travels as a signal over the swarm (hs/signal); in
// an op the oplog's signature covers it, and `signer`/`sig` are only carried along.
// action: 1 new (a part when parent is set), 3 claim, 4 release, 5 take, 6 heartbeat
// (signal only), 7 done (signal only: the land op's `items` is the record), 8 drop
hs.register({
  name: 'item-op',
  fields: [
    { name: 'item', type: 'fixed32', required: true },
    { name: 'action', type: 'uint', required: true },
    { name: 'writer', type: 'fixed32', required: true },
    // the claim's original time (what the lead rule reads) and this message's time (TTL)
    { name: 'time', type: 'uint' },
    { name: 'at', type: 'uint' },
    { name: 'ttl', type: 'uint' },
    { name: 'title', type: 'string' },
    { name: 'parent', type: 'fixed32' },
    { name: 'kind', type: 'string' },
    { name: 'paths', type: 'string', array: true },
    { name: 'note', type: 'string' },
    // co-claimants (writer keys): shared claimants are co-leads
    { name: 'with', type: 'fixed32', array: true },
    { name: 'signer', type: 'fixed32' },
    { name: 'sig', type: 'buffer' },
    // new: a suggested lead (a writer key): once they claim it, they lead
    { name: 'lead', type: 'fixed32' }
  ]
})

hs.register({
  name: 'op',
  fields: [
    { name: 'type', type: 'uint', required: true },
    { name: 'land', type: '@hs/land' },
    { name: 'addWriter', type: '@hs/add-writer' },
    { name: 'propose', type: '@hs/propose' },
    { name: 'review', type: '@hs/review' },
    // the main changeset (seq + chain hash) the writer had seen when it wrote this op; this
    // is how apply learns how far each writer has seen, which decides settlement
    { name: 'seen', type: '@hs/base' },
    { name: 'removeWriter', type: '@hs/remove-writer' },
    { name: 'item', type: '@hs/item-op' }
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
    { name: 'events', type: 'uint' },
    // every changeset up to here is settled: all indexers have seen it, so no concurrent land
    // can reorder it any more
    { name: 'settled', type: 'uint' }
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
    { name: 'proposal', type: 'uint' },
    // the land op's blobsLength (blobs core length plus one, 0 if not recorded)
    { name: 'blobsLength', type: 'uint' }
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
  fields: [
    { name: 'handle', type: 'string', required: true },
    { name: 'indexer', type: 'bool' },
    // removed by a remove-writer op: no longer a writer or an indexer (kept for its handle)
    { name: 'removed', type: 'bool' },
    { name: 'human', type: 'bool' },
    // new: autobee's ordering weight as granted (2 an indexer granted by a weight-2 writer, 1
    // otherwise; autobee caps a grant at the granter's weight). Absent: derived (see apply)
    { name: 'weight', type: 'uint' },
    // new: the team owner, who can mark writers human (the bootstrap writer, or the writer a
    // throwaway genesis named when it handed over to the hub: docs/FINALITY.md)
    { name: 'owner', type: 'bool' }
  ]
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
    { name: 'policy', type: 'string' },
    // per protected file: the lines it adds and removes (what approvals bind to there)
    { name: 'hunks', type: '@hs/hunk', array: true }
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
    { name: 'time', type: 'uint' },
    { name: 'item', type: 'fixed32' }
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
    { name: 'proposal', type: 'uint' },
    // new: our earlier lands, still unsettled when landNode landed; preLand* is the state
    // before the first of them, so undoing any of them restores them all (q0bs-min-3)
    { name: 'earlierLands', type: '@hs/head', array: true },
    // new: the paths those lands changed, so a restore replays ours and not teammates' changes
    // synced in after them (q0bs-min-3: a1's undone code came back as a2's)
    { name: 'landPaths', type: 'string', array: true }
  ]
})

// hs-item/<id>: an item and whether a land completed it
hs.register({
  name: 'item',
  fields: [
    { name: 'id', type: 'fixed32', required: true },
    { name: 'author', type: 'fixed32' },
    { name: 'time', type: 'uint' },
    { name: 'title', type: 'string' },
    { name: 'parent', type: 'fixed32' },
    { name: 'kind', type: 'string' },
    { name: 'paths', type: 'string', array: true },
    // the changeset that completed it (0: open) and who landed it
    { name: 'done', type: 'uint' },
    { name: 'doneBy', type: 'fixed32' },
    { name: 'dropped', type: 'bool' },
    // the suggested lead its author named, if any
    { name: 'lead', type: 'fixed32' },
    // approval (phase 2): what /.hsreview asked for when the item was made, pinned; the hash of
    // what approvals bind to (title, kind, paths); approvals so far
    { name: 'needs', type: 'uint' },
    { name: 'reviewers', type: 'fixed32', array: true },
    { name: 'hash', type: 'fixed32' },
    { name: 'approvals', type: 'uint' }
  ]
})

// hs-ptext/<path>: main's current text of a file /.hsreview protects (from lands that carried
// it inline); absent when unknown, and then approvals bind to exact content as before
hs.register({
  name: 'protected-text',
  fields: [{ name: 'text', type: 'string' }]
})

Hyperschema.toDisk(schema)
