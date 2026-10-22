// The autobee apply function for main. It must be total: a bad or conflicting op is
// recorded as an outcome, never thrown, since a throw closes the db.
//
// Landing is lock-free optimistic concurrency at path granularity. A land carries the
// base it forked from ({seq, hash} of the last accepted changeset it saw) and inlined
// entries. It is accepted iff the base is still on main's hash chain and no landed path
// was touched by a changeset after the base.
const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const unixPathResolve = require('unix-path-resolve')
const driveEntry = require('hyperdrive/lib/encoding')
const { getEncoding } = require('./schema/spec')
const keys = require('./keys')
const settle = require('./settle')
const rules = require('./rules')

const Op = getEncoding('@hs/op')
const Meta = getEncoding('@hs/meta')
const Changeset = getEncoding('@hs/changeset')
const Outcome = getEncoding('@hs/outcome')
const PathRecord = getEncoding('@hs/path')
const Hist = getEncoding('@hs/hist')
const Writer = getEncoding('@hs/writer')
const Proposal = getEncoding('@hs/proposal')
const ReviewRecord = getEncoding('@hs/review-record')
const Request = getEncoding('@hs/request')
const Event = getEncoding('@hs/event')
const Policy = getEncoding('@hs/policy')
const ProtectedText = getEncoding('@hs/protected-text')
const ItemOp = getEncoding('@hs/item-op')
const ItemRecord = getEncoding('@hs/item')

const OP_LAND = 1
const OP_ADD_WRITER = 2
const OP_PROPOSE = 3
const OP_REVIEW = 4
const OP_ACK = 5
const OP_REMOVE_WRITER = 6
const OP_ITEM = 7

// item actions (docs/TASKS.md); heartbeat and done travel only as signals
const ITEM_NEW = 1
const ITEM_CLAIM = 3
const ITEM_RELEASE = 4
const ITEM_TAKE = 5
const ITEM_HEARTBEAT = 6
const ITEM_DONE = 7
const ITEM_DROP = 8
const ITEM_RECORDED = new Set([ITEM_NEW, ITEM_CLAIM, ITEM_RELEASE, ITEM_TAKE, ITEM_DROP, ITEM_DONE])
const ITEM_LIMITS = { title: 300, note: 500, paths: 32, path: 512, with: 8, kind: 32 }

const ACCEPTED = 0
const CONFLICT = 1
const STALE_BASE = 2
const INVALID = 3
const NEEDS_REVIEW = 4
const STALE_REVIEW = 5

const STATUS = ['accepted', 'conflict', 'stale-base', 'invalid', 'needs-review', 'stale-review']

const APPROVE = 1
const CHANGES = 2
const COMMENT = 3
const VERDICTS = [null, 'approve', 'changes', 'comment']

const PROP_OPEN = 0
const PROP_APPROVED = 1
const PROP_LANDED = 2
const PROP_STATUS = ['open', 'approved', 'landed']

const POLICY_PATH = '/.hsreview'
const MAX_QUORUM = 64

const MAX_CONFLICTS_REPORTED = 64
const FILES_LISTED = 100

// opts.bootstrap: main's bootstrap writer key, an indexer until a remove-writer op removes it
async function apply(nodes, view, host, opts = {}) {
  const tx = new Overlay(view)
  tx.bootstrap = opts.bootstrap || null
  tx.lightBootstrap = !!opts.lightBootstrap

  for (const node of nodes) {
    let op = null
    try {
      op = c.decode(Op, node.value)
    } catch {
      await tx.outcome(node, { status: INVALID, reason: 'undecodable op' })
      continue
    }

    // a removed writer's ops change nothing: autobee keeps applying them (a removed writer
    // stays "added"), so this is where removal takes effect
    const writer = await tx.get(keys.writer(node.key))
    if (writer && c.decode(Writer, writer).removed) {
      await tx.outcome(node, { status: INVALID, reason: 'writer removed' })
      continue
    }

    await recordSeen(tx, node, op.seen)

    if (op.type === OP_LAND && op.land) await land(tx, node, op.land)
    else if (op.type === OP_ADD_WRITER && op.addWriter) {
      await addWriter(tx, node, op.addWriter, host)
    } else if (op.type === OP_PROPOSE && op.propose) {
      await propose(tx, node, op.propose)
    } else if (op.type === OP_REVIEW && op.review) {
      await review(tx, node, op.review)
    } else if (op.type === OP_REMOVE_WRITER && op.removeWriter) {
      await removeWriter(tx, node, op.removeWriter, host)
    } else if (op.type === OP_ITEM && op.item) {
      await itemOp(tx, node, op.item)
    } else if (op.type === OP_ACK) {
      tx.outcome(node, { status: ACCEPTED })
    } else {
      await tx.outcome(node, { status: INVALID, reason: 'unknown op type' })
    }

    await advanceSettled(tx, node)
  }

  await tx.flush()
}

// A writer's op says which changeset it had seen. Only markers that match main's chain count,
// so after a reorg changes #n, old claims about #n stop counting.
async function recordSeen(tx, node, seen) {
  if (!seen || !seen.hash) return
  const meta = await tx.meta()
  if (seen.seq > meta.seq) return
  const expected = seen.seq === 0 ? keys.ZERO : await tx.changesetHash(seen.seq)
  if (!expected || !b4a.equals(expected, seen.hash)) return
  if (seen.seq <= (await tx.seenBy(node.key))) return
  tx.put(keys.seen(node.key), c.encode(PathRecord, { seq: seen.seq }))
}

// Settled: every changeset up to the lowest point all indexers have seen. Indexers carry the
// heaviest weight in autobee's ordering, so a node they have all built on is ordered ahead of
// anything they haven't seen and can no longer be reordered (see DESIGN.md, finality).
async function advanceSettled(tx, node) {
  const settlers = await tx.settlers()
  if (!settlers.length) return
  let settled = Infinity
  for (const key of settlers) settled = Math.min(settled, await tx.seenBy(key))
  const meta = await tx.meta()
  settled = Math.min(settled, meta.seq)
  if (settled <= (meta.settled || 0)) return
  tx.setMeta({ ...meta, settled })
  await tx.event({ type: 'settled', actor: node.key, seq: settled })
}

// the base must be on main's chain; after a reorg a fork point can disappear
async function checkBase(tx, base) {
  const meta = await tx.meta()
  if (base.seq > meta.seq) return 'unknown base'
  const expected = base.seq === 0 ? keys.ZERO : await tx.changesetHash(base.seq)
  if (expected === null || !b4a.equals(expected, base.hash)) return 'base not on main'
  return null
}

// validated entries, or { reason }
function collectEntries(op) {
  const entries = []
  const seen = new Set()
  // optional arrays decode as null when absent
  for (const e of op.entries || []) {
    const reason = validateEntry(e, seen)
    if (reason) return { reason }
    entries.push(e)
  }
  if (entries.length === 0) return { reason: 'empty' }
  return { entries }
}

// A change to /.hsreview must carry the file's text inline, matching the entry's content hash,
// so apply can enforce review policy without fetching blobs. Returns { text } (null when the
// policy file is untouched, '' when deleted) or { reason }.
function policyChange(entries, text) {
  const e = entries.find((x) => x.path === POLICY_PATH)
  if (!e) return { text: null }
  if (!e.value) return { text: '' }
  // an empty text encodes as absent; the content hash decides either way
  const t = typeof text === 'string' ? text : ''
  if (!e.decoded.hash || !b4a.equals(crypto.hash(b4a.from(t)), e.decoded.hash)) {
    return { reason: POLICY_PATH + ' changes must include its text, matching its content hash' }
  }
  return { text: t }
}

// TO-FIVE #17: the inline texts of protected files, kept only where they match the entry's
// content hash (and aren't too big to keep in the view). Map path -> text
const TEXT_MAX = 256 * 1024

function inlineTexts(entries, texts) {
  const out = new Map()
  for (const t of texts || []) {
    const e = entries.find((x) => x.path === t.path)
    if (!e || !e.value || !e.decoded || !e.decoded.hash) continue
    const text = t.text || ''
    if (text.length > TEXT_MAX) continue
    if (b4a.equals(crypto.hash(b4a.from(text)), e.decoded.hash)) out.set(t.path, text)
  }
  return out
}

// the lines `after` adds to and removes from `before`, as sorted multisets: position-free, so
// teammates' sections merging around them leave them the same (and reordering approved lines
// isn't caught: fine for a review gate, see docs/TASKS.md)
function lineDelta(before, after) {
  const count = new Map()
  for (const l of before.split('\n')) count.set(l, (count.get(l) || 0) - 1)
  for (const l of after.split('\n')) count.set(l, (count.get(l) || 0) + 1)
  const added = []
  const removed = []
  for (const [l, n] of count) {
    for (let i = 0; i < n; i++) added.push(l)
    for (let i = 0; i < -n; i++) removed.push(l)
  }
  return { added: added.sort(), removed: removed.sort() }
}

function sameContent(a, b) {
  try {
    const x = c.decode(driveEntry, a).hash
    const y = c.decode(driveEntry, b).hash
    return !!x && !!y && b4a.equals(x, y)
  } catch {
    return false
  }
}

function sameLines(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// main's text of protected files apply doesn't know yet, from an op that carries it: kept when
// the file is unchanged since the op's base and the text matches main's entry
async function learnMainTexts(tx, op) {
  for (const t of op.mains || []) {
    if (typeof t.path !== 'string' || (await tx.get(keys.protectedText(t.path)))) continue
    const text = t.text || ''
    if (text.length > TEXT_MAX || (await tx.pathSeq(t.path)) > op.base.seq) continue
    const value = await tx.get(keys.files.encode(t.path))
    if (!value) continue
    let decoded = null
    try {
      decoded = c.decode(driveEntry, value)
    } catch {
      continue
    }
    if (!decoded.hash || !b4a.equals(crypto.hash(b4a.from(text)), decoded.hash)) continue
    tx.put(keys.protectedText(t.path), c.encode(ProtectedText, { text }))
  }
}

async function mainText(tx, path) {
  const buf = await tx.get(keys.protectedText(path))
  return buf ? c.decode(ProtectedText, buf).text || '' : null
}

async function land(tx, node, op) {
  const meta = await tx.meta()
  const base = op.base

  const stale = await checkBase(tx, base)
  if (stale) return tx.outcome(node, { status: STALE_BASE, reason: stale })

  const collected = collectEntries(op)
  if (collected.reason) {
    const reason = collected.reason === 'empty' ? 'empty land' : collected.reason
    return tx.outcome(node, { status: INVALID, reason })
  }
  const entries = collected.entries

  const policy = policyChange(entries, op.policy)
  if (policy.reason) return tx.outcome(node, { status: INVALID, reason: policy.reason })
  const texts = inlineTexts(entries, op.texts)
  await learnMainTexts(tx, op)

  const conflicts = []
  for (const e of entries) {
    const last = await tx.pathSeq(e.path)
    if (last > base.seq) {
      conflicts.push(e.path)
      if (conflicts.length === MAX_CONFLICTS_REPORTED) break
    }
  }

  if (conflicts.length) return tx.outcome(node, { status: CONFLICT, conflicts })

  // opt-in policy from /.hsreview: protected paths only land through an approved proposal,
  // or (phase 2) an approved item this land names: its approvals satisfy the rule, its
  // recorded paths cover them, and the lander is its author or the lead it names. Named items
  // win over a proposal the workspace still carries (q2h-2: a3 proposed its section as a
  // fallback, the CR item was approved, and every `land --item` failed on the stale proposal)
  const req = rules.requirement(
    await tx.policyRules(),
    entries.map((e) => e.path)
  )
  const planned =
    !!req && (await approvedItemCovers(tx, node, [...(op.items || []), ...(op.under || [])], req))

  // Ask: an approved proposal, landed by its author with exactly the approved content
  let prop = null
  if (op.proposal && planned) {
    // the item carried it: the lander's proposal for the same change is done too (q2h-3:
    // it kept showing "approved: hs land" after the land)
    const superseded = await tx.proposal(op.proposal)
    if (
      superseded &&
      b4a.equals(superseded.author, node.key) &&
      superseded.status !== PROP_LANDED
    ) {
      prop = superseded
    }
  }
  if (op.proposal && !planned) {
    prop = await tx.proposal(op.proposal)
    if (!prop || !b4a.equals(prop.author, node.key)) {
      return tx.outcome(node, {
        status: INVALID,
        reason: 'no such proposal of yours: P' + op.proposal
      })
    }
    if (prop.status === PROP_LANDED) {
      return tx.outcome(node, { status: INVALID, reason: 'P' + prop.id + ' already landed' })
    }
    if (
      !b4a.equals(rules.contentHash(entries), prop.hash) &&
      !(await mergedSinceProposal(tx, prop, entries, texts))
    ) {
      return tx.outcome(node, {
        status: NEEDS_REVIEW,
        proposal: prop.id,
        reason: 'content changed since P' + prop.id + ' was reviewed: propose again'
      })
    }
    if (prop.status !== PROP_APPROVED) {
      return tx.outcome(node, {
        status: NEEDS_REVIEW,
        proposal: prop.id,
        reason: `P${prop.id} has ${prop.approvals || 0}/${prop.quorum || 1} approvals`
      })
    }
  }

  if (req && !planned) {
    const approvers = prop ? await tx.approvers(prop) : []
    let reason = null
    if (!prop) {
      reason = `${req.paths.join(' ')} need${req.paths.length === 1 ? 's' : ''} ${req.approvals} approval(s) (${req.pattern} in ${POLICY_PATH}): propose it, or land it with --task/--under an approved task that names them`
    } else if (approvers.length < req.approvals) {
      reason = `${req.pattern} needs ${req.approvals} approval(s), P${prop.id} has ${approvers.length}`
    } else if (req.reviewers.length) {
      const wanted = await tx.keysOf(req.reviewers)
      if (!approvers.some((k) => wanted.some((w) => b4a.equals(w, k)))) {
        reason = `${req.pattern} needs an approval from one of ${req.reviewers.join(', ')}`
      }
    }
    if (reason) {
      return tx.outcome(node, { status: NEEDS_REVIEW, reason, proposal: prop ? prop.id : 0 })
    }
  }

  const seq = meta.seq + 1
  const hash = crypto.hash([meta.hash, node.value])

  for (const e of entries) {
    // before/after values for `hs show` (one extra lookup per path)
    const prev = await tx.get(keys.files.encode(e.path))
    tx.put(keys.hist(e.path, seq), c.encode(Hist, { prev, next: e.value }))

    if (e.value) {
      tx.put(keys.files.encode(e.path), e.value)
      const h = e.decoded.hash
      if (h && !(await tx.has(keys.hash(h)))) tx.put(keys.hash(h), e.value)
    } else {
      tx.del(keys.files.encode(e.path))
    }
    tx.put(keys.path(e.path), c.encode(PathRecord, { seq }))
  }

  tx.put(
    keys.cs(seq),
    c.encode(Changeset, {
      seq,
      hash,
      writer: node.key,
      node: node.length,
      ws: op.ws,
      base,
      paths: entries.length,
      message: op.message,
      author: op.author,
      time: op.time,
      blobs: op.blobs,
      files: entries.slice(0, FILES_LISTED).map((e) => (e.value ? e.path : '-' + e.path)),
      proposal: prop ? prop.id : 0,
      blobsLength: op.blobsLength || 0
    })
  )
  tx.setMeta({ ...meta, seq, hash })

  if (policy.text !== null) tx.put(keys.policy, c.encode(Policy, { text: policy.text }))

  // main's text of protected files, for later proposals' line checks (unknown: dropped)
  const rulesNow = await tx.policyRules()
  for (const e of entries) {
    if (texts.has(e.path)) {
      tx.put(keys.protectedText(e.path), c.encode(ProtectedText, { text: texts.get(e.path) }))
    } else if (!e.value || rules.requirement(rulesNow, [e.path])) {
      tx.del(keys.protectedText(e.path))
    }
  }

  if (prop) {
    tx.putProposal({ ...prop, status: PROP_LANDED, landed: seq })
    await tx.event({ type: 'landed', actor: node.key, proposal: prop.id, seq, time: op.time })
  }

  // Show: landed, and these teammates are asked to look at it
  const reviewers = (await tx.keysOf(op.reviewers || [])).filter((k) => !b4a.equals(k, node.key))
  if (reviewers.length) {
    tx.put(keys.request(seq), c.encode(Request, { author: node.key, reviewers }))
    await tx.event({ type: 'request', actor: node.key, seq, reviewers, time: op.time })
  }

  // items this land completes (claims): done while it stays accepted; replay after a reorg
  // that flips it simply doesn't mark them
  for (const id of (op.items || []).slice(0, ITEM_LIMITS.paths)) {
    const item = await tx.item(id)
    if (item && item.done) continue
    tx.put(
      keys.item(id),
      c.encode(ItemRecord, { ...(item || { id }), done: seq, doneBy: node.key })
    )
    await tx.event({ type: 'done', actor: node.key, seq, item: id, time: op.time })
    if (item && item.parent) await partsDone(tx, node, item.parent, seq, op.time)
  }

  return tx.outcome(node, { status: ACCEPTED, seq })
}

async function approvedItemCovers(tx, node, ids, req) {
  const wanted = req.reviewers.length ? await tx.keysOf(req.reviewers) : []
  for (const id of ids.slice(0, ITEM_LIMITS.paths)) {
    const item = await tx.item(id)
    if (!item || !item.author || item.done || item.dropped) continue
    if (!req.paths.every((p) => rules.covers(item.paths || [], p))) continue
    // only its author or the lead it names: what the approver saw (both are in its hash).
    // Claims are open to anyone and bind to nothing, so they can't carry an approval
    const mine = b4a.equals(item.author, node.key) || (item.lead && b4a.equals(item.lead, node.key))
    if (!mine) continue
    const approvers = await tx.itemApprovers(item)
    if (approvers.length < req.approvals) continue
    if (wanted.length && !approvers.some((k) => wanted.some((w) => b4a.equals(w, k)))) continue
    return true
  }
  return false
}

// a review of an item (phase 2): approvals pin its hash, as proposal approvals pin content
async function itemReview(tx, node, op) {
  const item = await tx.item(op.item)
  // a review can arrive before its item (signals first): keep it, it counts when the item does
  const known = item && item.author
  if (
    known &&
    op.verdict !== COMMENT &&
    (!op.hash || !item.hash || !b4a.equals(op.hash, item.hash))
  ) {
    return tx.outcome(node, { status: STALE_REVIEW, reason: 'the task changed since you looked' })
  }
  tx.put(
    keys.itemReview(op.item, node.key),
    c.encode(ReviewRecord, {
      writer: node.key,
      verdict: op.verdict,
      hash: op.hash || null,
      comment: op.comment,
      time: op.time
    })
  )
  await tx.event({
    type: 'item-review',
    actor: node.key,
    item: op.item,
    verdict: op.verdict,
    comment: op.comment,
    time: op.time
  })
  if (!known) return tx.outcome(node, { status: ACCEPTED })
  const approvals = (await tx.itemApprovers(item)).length
  if (approvals !== (item.approvals || 0)) {
    tx.put(keys.item(op.item), c.encode(ItemRecord, { ...item, approvals }))
    if (item.needs && approvals >= item.needs && (item.approvals || 0) < item.needs) {
      await tx.event({ type: 'item-approved', actor: node.key, item: op.item, time: op.time })
    }
  }
  return tx.outcome(node, { status: ACCEPTED })
}

// every part of a parent item is done: say so (its lead closes it; the parent may still have
// work of its own)
async function partsDone(tx, node, parent, seq, time) {
  const p = await tx.item(parent)
  if (!p || p.done || p.dropped) return
  for (const it of await tx.items()) {
    if (it.parent && b4a.equals(it.parent, parent) && !it.done && !it.dropped) return
  }
  await tx.event({ type: 'parts-done', actor: node.key, seq, item: parent, time })
}

// An item or a claim on one (docs/TASKS.md). The oplog's signature already covers the op,
// so the payload's own signature (for signals) isn't checked here: apply stays cheap and
// deterministic. Claims are keyed per (item, writer) and touch no paths, so they never
// conflict; the lead is computed from their content by readers, not decided here.
async function itemOp(tx, node, op) {
  const invalid = (reason) => tx.outcome(node, { status: INVALID, reason })
  if (!b4a.equals(op.writer, node.key)) return invalid('task op signed for another writer')
  if (!ITEM_RECORDED.has(op.action)) return invalid('bad task action')
  if ((op.title || '').length > ITEM_LIMITS.title || (op.note || '').length > ITEM_LIMITS.note) {
    return invalid('task text too long')
  }
  if ((op.kind || '').length > ITEM_LIMITS.kind) return invalid('task kind too long')
  const paths = op.paths || []
  if (paths.length > ITEM_LIMITS.paths || paths.some((p) => p.length > ITEM_LIMITS.path)) {
    return invalid('too many task paths')
  }
  if ((op.with || []).length > ITEM_LIMITS.with) return invalid('too many co-leads')

  if (op.action === ITEM_NEW) {
    const existing = await tx.item(op.item)
    if (existing && existing.author) return tx.outcome(node, { status: ACCEPTED })
    // what /.hsreview asks of an item like this, pinned now: a later policy edit doesn't change
    // what open items need
    const req = rules.itemRequirement(await tx.itemRules(), { kind: op.kind || '', paths })
    let needs = 0
    let reviewers = []
    if (req) {
      needs = req.approvals
      reviewers = await tx.keysOf(req.reviewers)
      if (req.reviewers.length && !reviewers.length) {
        return invalid(
          `${req.reviewers.join(', ')} must approve tasks like this, and there is no one: ` +
            (req.reviewers.includes('@humans')
              ? 'hs add-writer <key> --as <name> --human'
              : 'add them first')
        )
      }
    }
    const hash = rules.itemHash({
      id: op.item,
      title: op.title || '',
      kind: op.kind || '',
      paths,
      lead: op.lead || null
    })
    tx.put(
      keys.item(op.item),
      c.encode(ItemRecord, {
        ...(existing || {}),
        id: op.item,
        author: node.key,
        time: op.time || 0,
        title: op.title || '',
        parent: op.parent || null,
        kind: op.kind || '',
        paths,
        lead: op.lead || null,
        needs,
        reviewers,
        hash,
        approvals: 0
      })
    )
    await tx.event({ type: 'item', actor: node.key, item: op.item, time: op.time })
    if (needs) {
      await tx.event({
        type: 'item-request',
        actor: node.key,
        item: op.item,
        reviewers,
        time: op.time
      })
    }
    // approvals that arrived before the item did (signals travel first) count now
    const created = await tx.item(op.item)
    const early = (await tx.itemApprovers(created)).length
    if (early) tx.put(keys.item(op.item), c.encode(ItemRecord, { ...created, approvals: early }))
    return tx.outcome(node, { status: ACCEPTED })
  }

  // done without a land: the item's author, or someone holding a claim on it (a parent whose
  // parts all landed, work that turned out to be done already)
  if (op.action === ITEM_DONE) {
    const item = await tx.item(op.item)
    if (!item) return invalid('no such task')
    if (item.done) return tx.outcome(node, { status: ACCEPTED })
    const mine = await tx.get(keys.claim(op.item, node.key))
    const holds = mine && c.decode(ItemOp, mine).action !== ITEM_RELEASE
    if (!(item.author && b4a.equals(item.author, node.key)) && !holds) {
      return invalid('only its author or someone on it can mark a task done')
    }
    const seq = (await tx.meta()).seq
    tx.put(keys.item(op.item), c.encode(ItemRecord, { ...item, done: seq || 1, doneBy: node.key }))
    await tx.event({ type: 'done', actor: node.key, seq, item: op.item, time: op.at || op.time })
    if (item.parent) await partsDone(tx, node, item.parent, seq, op.at || op.time)
    return tx.outcome(node, { status: ACCEPTED })
  }

  if (op.action === ITEM_DROP) {
    const item = await tx.item(op.item)
    if (!item || !item.author || !b4a.equals(item.author, node.key)) {
      return invalid('only whoever filed a task can drop it')
    }
    tx.put(keys.item(op.item), c.encode(ItemRecord, { ...item, dropped: true }))
    await tx.event({ type: 'drop', actor: node.key, item: op.item, time: op.at || op.time })
    return tx.outcome(node, { status: ACCEPTED })
  }

  // claim, take, release: each writer's latest action per item, by its own message time
  const key = keys.claim(op.item, node.key)
  const prev = await tx.get(key)
  if (prev) {
    const old = c.decode(ItemOp, prev)
    if ((old.at || 0) > (op.at || 0)) return tx.outcome(node, { status: ACCEPTED })
  }
  tx.put(key, c.encode(ItemOp, { ...op, sig: null, signer: null }))
  const type = op.action === ITEM_CLAIM ? 'claim' : op.action === ITEM_TAKE ? 'take' : 'release'
  await tx.event({ type, actor: node.key, item: op.item, time: op.at || op.time })
  return tx.outcome(node, { status: ACCEPTED })
}

// An approved proposal whose files picked up teammates' changes on the way to landing keeps
// its approval when only those merges differ: the land touches exactly the proposal's paths,
// each path either carries the approved entry or changed on main after the proposal's base
// (so the author merged it in), and no merged path is protected by /.hsreview (those stay
// pinned to the exact content a reviewer saw). Returns the merged paths, or null.
async function mergedSinceProposal(tx, prop, entries, texts = new Map()) {
  const approved = new Map((prop.entries || []).map((e) => [e.path, e.value || null]))
  if (approved.size !== entries.length) return null
  const hunks = new Map((prop.hunks || []).map((h) => [h.path, h]))
  const merged = []
  for (const e of entries) {
    if (!approved.has(e.path)) return null
    const want = approved.get(e.path)
    const got = e.value || null
    if (want === null && got === null) continue
    if (want && got && b4a.equals(want, got)) continue
    // the same bytes written again (a new blob): the same content as approved
    if (want && got && sameContent(want, got)) continue
    if ((await tx.pathSeq(e.path)) <= prop.base.seq) return null
    // a protected file teammates changed too (TO-FIVE #17): fine if this land adds and removes
    // exactly the lines that were approved, against main as it is now
    const hunk = hunks.get(e.path)
    const now = hunk && texts.has(e.path) ? await mainText(tx, e.path) : null
    if (now !== null) {
      const d = lineDelta(now, texts.get(e.path))
      if (!sameLines(d.added, hunk.added || []) || !sameLines(d.removed, hunk.removed || [])) {
        return null
      }
      continue
    }
    merged.push(e.path)
  }
  // any other merged path must be unprotected: its content was never reviewed
  if (merged.length && rules.requirement(await tx.policyRules(), merged)) return null
  return merged.length || hunks.size ? merged : null
}

// Take a writer out: a hub that is gone for good, a lost key. Its later ops change nothing
// (ignored at the top of apply; autobee gives a removed non-genesis writer weight 0, so
// they also sort after everything). If it was an indexer,
// settlement stops waiting for it (the settled point is recomputed over the rest on this
// very node; with no indexer left it waits for every writer). Settlement needs every
// indexer, not a quorum: autobee orders indexers' concurrent nodes by timestamp, so an
// indexer outside a quorum could still reorder (DESIGN.md §11).
async function removeWriter(tx, node, op, host) {
  const key = op.key
  const buf = await tx.get(keys.writer(key))
  const isBootstrap = !!tx.bootstrap && b4a.equals(key, tx.bootstrap)
  if (!buf && !isBootstrap) {
    return tx.outcome(node, { status: INVALID, reason: 'not a writer' })
  }
  const prev = buf ? c.decode(Writer, buf) : { handle: '', indexer: !tx.lightBootstrap }
  if (prev.removed) return tx.outcome(node, { status: INVALID, reason: 'already removed' })

  // autobee keeps a removed genesis writer's weight (lib/witness.js currentWeight), so the
  // bootstrap writer's unseen ops still sort by it after removal. Heavy (repos before milestone
  // 7, and the throwaway genesis of init --hub): removable only by itself, while an indexer of
  // weight 2 remains to settle; its later ops come after its own removal, so apply ignores
  // them (docs/FINALITY.md). Light (a plain writer): removable while an indexer remains.
  if (isBootstrap) {
    const self = b4a.equals(node.key, key)
    if (!tx.lightBootstrap && !(self && (await heavyIndexer(tx, key)))) {
      return tx.outcome(node, {
        status: INVALID,
        reason:
          "this repo's bootstrap writer is an indexer: only it can step down, and only while " +
          'another indexer of weight 2 (a hub) remains'
      })
    }
    if (!(await tx.indexers()).length) {
      return tx.outcome(node, {
        status: INVALID,
        reason: 'the bootstrap writer can be removed only while an indexer (a hub) remains'
      })
    }
  }

  // removing the last indexer is fine: settlement falls back to every writer's acks (and a
  // removed non-genesis writer's later ops get weight 0 from autobee)
  tx.put(
    keys.writer(key),
    c.encode(Writer, { handle: prev.handle || '', indexer: false, removed: true })
  )
  host.removeWriter(key)
  return tx.outcome(node, { status: ACCEPTED })
}

// an indexer of weight 2 other than `except`, still in the repo
async function heavyIndexer(tx, except) {
  for (const { key, value } of await tx.scan(keys.writerRange())) {
    const k = keys.writerKeyOf(key)
    if (b4a.equals(k, except)) continue
    const w = c.decode(Writer, value)
    if (w.indexer && !w.removed && settle.weightOf(w, tx.lightBootstrap) >= 2) return true
  }
  return false
}

async function addWriter(tx, node, op, host) {
  const handle = op.handle
  const prevBuf = await tx.get(keys.writer(op.key))
  const prev = prevBuf ? c.decode(Writer, prevBuf) : { handle: '', indexer: false }

  if (handle) {
    if (!rules.HANDLE.test(handle)) {
      return tx.outcome(node, { status: INVALID, reason: 'bad handle: ' + handle })
    }
    const owner = await tx.get(keys.handle(handle))
    if (owner && !b4a.equals(owner, op.key)) {
      return tx.outcome(node, { status: INVALID, reason: 'handle taken: ' + handle })
    }
    if (prev.handle && prev.handle !== handle) tx.del(keys.handle(prev.handle))
    tx.put(keys.handle(handle), op.key)
  }

  // a person, not an agent: only the team owner (the bootstrap writer, or the writer a
  // throwaway genesis named owner) can say so
  if (op.human && !(await tx.isOwner(node.key))) {
    return tx.outcome(node, {
      status: INVALID,
      reason: 'only the team owner can mark a writer as human'
    })
  }
  // naming the owner is the genesis writer's alone (init --hub hands over: docs/FINALITY.md)
  if (op.owner && !(tx.bootstrap && b4a.equals(node.key, tx.bootstrap))) {
    return tx.outcome(node, { status: INVALID, reason: 'only the genesis writer names the owner' })
  }
  // re-adding a removed writer makes it a writer again (an indexer only if asked again)
  const indexer = !!op.indexer || (!!prev.indexer && !prev.removed)
  // autobee's weight: 2 asked for an indexer, capped at the granter's (autobee lib/system.js
  // addWriter); it never goes down on a re-add
  const granted = Math.min(indexer ? 2 : 1, await tx.weightOf(node.key))
  const record = {
    handle: handle || prev.handle || '',
    indexer,
    removed: false,
    human: !!op.human || !!prev.human,
    weight: Math.max(granted, prev.weight || 0),
    owner: !!op.owner || !!prev.owner
  }
  tx.put(keys.writer(op.key), c.encode(Writer, record))
  host.addWriter(op.key, { isIndexer: record.indexer })
  return tx.outcome(node, { status: ACCEPTED })
}

async function propose(tx, node, op) {
  const stale = await checkBase(tx, op.base)
  if (stale) return tx.outcome(node, { status: STALE_BASE, reason: stale })

  const collected = collectEntries(op)
  if (collected.reason) {
    const reason = collected.reason === 'empty' ? 'empty proposal' : collected.reason
    return tx.outcome(node, { status: INVALID, reason })
  }
  const entries = collected.entries

  const policy = policyChange(entries, op.policy)
  if (policy.reason) return tx.outcome(node, { status: INVALID, reason: policy.reason })

  const handles = op.reviewers || []
  const reviewerKeys = await tx.keysOf(handles)
  if (reviewerKeys.length !== handles.length) {
    return tx.outcome(node, { status: INVALID, reason: 'unknown reviewer in ' + handles.join(',') })
  }

  let prop = null
  let type = 'proposal'
  if (op.replaces) {
    prop = await tx.proposal(op.replaces)
    if (!prop || !b4a.equals(prop.author, node.key) || prop.status === PROP_LANDED) {
      return tx.outcome(node, { status: INVALID, reason: 'cannot update P' + op.replaces })
    }
    type = 'proposal-updated'
  } else {
    const meta = await tx.meta()
    const id = (meta.proposals || 0) + 1
    tx.setMeta({ ...meta, proposals: id })
    prop = { id, author: node.key, revision: 0, quorum: 1, reviewers: [] }
  }

  prop = {
    ...prop,
    ws: op.ws,
    base: op.base,
    entries: entries.map((e) => ({ path: e.path, value: e.value || null })),
    hash: rules.contentHash(entries),
    message: op.message,
    time: op.time,
    blobs: op.blobs,
    blobsLength: op.blobsLength || 0,
    reviewers:
      handles.length || !op.replaces
        ? reviewerKeys.filter((k) => !b4a.equals(k, node.key))
        : prop.reviewers,
    quorum: Math.max(1, Math.min(op.quorum || prop.quorum || 1, MAX_QUORUM)),
    revision: op.replaces ? (prop.revision || 0) + 1 : 0,
    status: PROP_OPEN,
    approvals: 0,
    landed: 0,
    policy: policy.text === null ? null : policy.text,
    hunks: await proposalHunks(tx, entries, op)
  }
  tx.putProposal(prop)
  await tx.event({
    type,
    actor: node.key,
    proposal: prop.id,
    reviewers: prop.reviewers,
    time: op.time
  })

  return tx.outcome(node, { status: ACCEPTED, proposal: prop.id })
}

// the lines a proposal adds and removes in each protected file it carries text for, against
// main's text, when that file hasn't changed on main since the proposal's base (TO-FIVE #17)
async function proposalHunks(tx, entries, op) {
  await learnMainTexts(tx, op)
  const texts = inlineTexts(entries, op.texts)
  const out = []
  for (const [path, text] of texts) {
    if ((await tx.pathSeq(path)) > op.base.seq) continue
    let base = await mainText(tx, path)
    if (base === null && !(await tx.get(keys.files.encode(path)))) base = '' // a new file
    if (base === null) continue
    out.push({ path, ...lineDelta(base, text) })
  }
  return out.length ? out : null
}

async function review(tx, node, op) {
  if (!VERDICTS[op.verdict]) return tx.outcome(node, { status: INVALID, reason: 'bad verdict' })
  if (op.item) return itemReview(tx, node, op)
  const record = {
    writer: node.key,
    verdict: op.verdict,
    hash: op.hash || null,
    comment: op.comment,
    time: op.time
  }

  if (op.proposal) {
    const prop = await tx.proposal(op.proposal)
    if (!prop) {
      return tx.outcome(node, { status: INVALID, reason: 'no such proposal P' + op.proposal })
    }
    // approvals and change requests are pinned to the content they reviewed
    if (op.verdict !== COMMENT && (!op.hash || !b4a.equals(op.hash, prop.hash))) {
      return tx.outcome(node, {
        status: STALE_REVIEW,
        proposal: prop.id,
        reason: `P${prop.id} changed (revision ${prop.revision}) since you looked; review it again`
      })
    }
    tx.put(keys.review(keys.TARGET_PROPOSAL, prop.id, node.key), c.encode(ReviewRecord, record))
    await tx.event({
      type: 'review',
      actor: node.key,
      proposal: prop.id,
      verdict: op.verdict,
      comment: op.comment,
      time: op.time
    })

    if (prop.status !== PROP_LANDED) {
      const approvals = (await tx.approvers(prop)).length
      const quorum = prop.quorum || 1
      const status = approvals >= quorum ? PROP_APPROVED : PROP_OPEN
      if (status === PROP_APPROVED && prop.status !== PROP_APPROVED) {
        await tx.event({ type: 'approved', actor: node.key, proposal: prop.id, time: op.time })
      }
      tx.putProposal({ ...prop, approvals, status })
    }
    return tx.outcome(node, { status: ACCEPTED, proposal: prop.id })
  }

  if (op.seq) {
    if (!(await tx.has(keys.cs(op.seq)))) {
      return tx.outcome(node, { status: INVALID, reason: 'no such changeset #' + op.seq })
    }
    tx.put(keys.review(keys.TARGET_CHANGESET, op.seq, node.key), c.encode(ReviewRecord, record))
    await tx.event({
      type: 'review',
      actor: node.key,
      seq: op.seq,
      verdict: op.verdict,
      comment: op.comment,
      time: op.time
    })
    return tx.outcome(node, { status: ACCEPTED, seq: op.seq })
  }

  return tx.outcome(node, { status: INVALID, reason: 'review needs a proposal or a changeset' })
}

function validateEntry(e, seen) {
  const p = e.path
  if (typeof p !== 'string' || p.length === 0 || p === '/') return 'bad path'
  if (unixPathResolve('/', p) !== p) return 'path not normalized: ' + p
  if (seen.has(p)) return 'duplicate path: ' + p
  seen.add(p)

  if (!e.value) return null

  try {
    e.decoded = c.decode(driveEntry, e.value)
  } catch {
    return 'undecodable entry: ' + p
  }

  // main has no blobs core of its own, every blob must say where it lives
  if (e.decoded.blob && !e.decoded.blob.core) return 'blob without core: ' + p
  return null
}

// Read-your-writes overlay so several ops in one apply batch see each other,
// flushed as a single hyperbee2 batch.
class Overlay {
  constructor(view) {
    this.view = view
    this.pending = new Map()
    this._meta = null
  }

  async get(key) {
    const hex = b4a.toString(key, 'hex')
    if (this.pending.has(hex)) return this.pending.get(hex).value
    const node = await this.view.get(key)
    return node ? node.value : null
  }

  async has(key) {
    return (await this.get(key)) !== null
  }

  put(key, value) {
    this.pending.set(b4a.toString(key, 'hex'), { key, value })
  }

  del(key) {
    this.pending.set(b4a.toString(key, 'hex'), { key, value: null })
  }

  async meta() {
    if (this._meta) return this._meta
    const buf = await this.get(keys.meta)
    this._meta = buf ? c.decode(Meta, buf) : { seq: 0, hash: keys.ZERO, proposals: 0, events: 0 }
    return this._meta
  }

  // range read that also sees this batch's pending writes
  async scan(range) {
    const out = new Map()
    for await (const node of this.view.createReadStream(range)) {
      out.set(b4a.toString(node.key, 'hex'), { key: node.key, value: node.value })
    }
    for (const [hex, entry] of this.pending) {
      const k = entry.key
      if (range.gte && b4a.compare(k, range.gte) < 0) continue
      if (range.gt && b4a.compare(k, range.gt) <= 0) continue
      if (range.lt && b4a.compare(k, range.lt) >= 0) continue
      if (range.lte && b4a.compare(k, range.lte) > 0) continue
      if (entry.value === null) out.delete(hex)
      else out.set(hex, entry)
    }
    return [...out.values()].sort((a, b) => b4a.compare(a.key, b.key))
  }

  async proposal(id) {
    const buf = await this.get(keys.prop(id))
    return buf ? c.decode(Proposal, buf) : null
  }

  putProposal(prop) {
    this.put(keys.prop(prop.id), c.encode(Proposal, prop))
  }

  // distinct non-author writers whose latest review approves the proposal's current content
  async approvers(prop) {
    const out = []
    for (const { value } of await this.scan(keys.reviewRange(keys.TARGET_PROPOSAL, prop.id))) {
      const r = c.decode(ReviewRecord, value)
      if (r.verdict !== APPROVE || !r.hash || !b4a.equals(r.hash, prop.hash)) continue
      if (b4a.equals(r.writer, prop.author)) continue
      out.push(r.writer)
    }
    return out
  }

  // writer keys for handles; unknown handles are skipped
  async keysOf(handles) {
    const out = []
    for (const h of handles) {
      if (h === '@humans') {
        for (const k of await this.humans()) if (!out.some((x) => b4a.equals(x, k))) out.push(k)
        continue
      }
      if (typeof h !== 'string' || !rules.HANDLE.test(h)) continue
      const key = await this.get(keys.handle(h))
      if (key && !out.some((k) => b4a.equals(k, key))) out.push(key)
    }
    return out
  }

  // writers the team owner marked human (and not removed)
  async humans() {
    const out = []
    for (const { key, value } of await this.scan(keys.writerRange())) {
      const w = c.decode(Writer, value)
      if (w.human && !w.removed) out.push(keys.writerKeyOf(key))
    }
    return out
  }

  // writers whose latest review approves an item as it is now (its hash), excluding its author
  // and, if the item names reviewers, anyone else
  async itemApprovers(item) {
    const out = []
    if (!item.hash) return out
    for (const { value } of await this.scan(keys.itemReviewRange(item.id))) {
      const r = c.decode(ReviewRecord, value)
      if (r.verdict !== APPROVE || !r.hash || !b4a.equals(r.hash, item.hash)) continue
      if (item.author && b4a.equals(r.writer, item.author)) continue
      if ((item.reviewers || []).length && !item.reviewers.some((k) => b4a.equals(k, r.writer))) {
        continue
      }
      out.push(r.writer)
    }
    return out
  }

  async seenBy(key) {
    const buf = await this.get(keys.seen(key))
    return buf ? c.decode(PathRecord, buf).seq : 0
  }

  // the bootstrap writer (unless removed) plus writers added as indexers and not removed
  async indexers() {
    const out = []
    let bootstrapRemoved = false
    for (const { key, value } of await this.scan(keys.writerRange())) {
      const w = c.decode(Writer, value)
      const k = keys.writerKeyOf(key)
      if (this.bootstrap && b4a.equals(k, this.bootstrap) && w.removed) bootstrapRemoved = true
      if (w.indexer && !w.removed && !out.some((x) => b4a.equals(x, k))) out.push(k)
    }
    if (
      this.bootstrap &&
      !this.lightBootstrap &&
      !bootstrapRemoved &&
      !out.some((x) => b4a.equals(x, this.bootstrap))
    ) {
      out.unshift(this.bootstrap)
    }
    return out
  }

  // whose acks settlement waits for: the indexers that outweigh every other writer in
  // autobee's order, or every writer when none does (lib/settle.js, docs/FINALITY.md)
  async settlers() {
    const writers = (await this.scan(keys.writerRange())).map(({ key, value }) => ({
      key: keys.writerKeyOf(key),
      value: c.decode(Writer, value)
    }))
    return settle.settlers(writers, {
      bootstrap: this.bootstrap,
      lightBootstrap: this.lightBootstrap
    })
  }

  // a writer's autobee weight (the bootstrap writer's is the repo's bootstrap weight)
  async weightOf(key) {
    if (this.bootstrap && b4a.equals(key, this.bootstrap)) return this.lightBootstrap ? 1 : 2
    const buf = await this.get(keys.writer(key))
    return buf ? settle.weightOf(c.decode(Writer, buf), this.lightBootstrap) : 1
  }

  // the team owner: the bootstrap writer, or a writer it named owner
  async isOwner(key) {
    if (this.bootstrap && b4a.equals(key, this.bootstrap)) return true
    const buf = await this.get(keys.writer(key))
    return !!buf && !!c.decode(Writer, buf).owner
  }

  async policyRules() {
    const buf = await this.get(keys.policy)
    return buf ? rules.parseReview(c.decode(Policy, buf).text) : []
  }

  async itemRules() {
    const buf = await this.get(keys.policy)
    return buf ? rules.parseItemRules(c.decode(Policy, buf).text) : []
  }

  async item(id) {
    const node = await this.get(keys.item(id))
    return node ? c.decode(ItemRecord, node) : null
  }

  // every item, with this batch's pending writes applied
  async items() {
    const prefix = keys.item(b4a.alloc(32)).subarray(0, -32)
    const isItem = (key) =>
      key.length === prefix.length + 32 && b4a.equals(key.subarray(0, prefix.length), prefix)
    const byId = new Map()
    for await (const node of this.view.createReadStream(keys.itemRange())) {
      byId.set(b4a.toString(node.key, 'hex'), node.key)
    }
    for (const [hex, entry] of this.pending) if (isItem(entry.key)) byId.set(hex, entry.key)
    const out = []
    for (const key of byId.values()) {
      const it = await this.get(key)
      if (it) out.push(c.decode(ItemRecord, it))
    }
    return out
  }

  async event(fields) {
    const meta = await this.meta()
    const n = (meta.events || 0) + 1
    this.setMeta({ ...meta, events: n })
    this.put(keys.event(n), c.encode(Event, { n, ...fields }))
  }

  setMeta(m) {
    this._meta = m
    this.put(keys.meta, c.encode(Meta, m))
  }

  async changesetHash(seq) {
    const buf = await this.get(keys.cs(seq))
    return buf ? c.decode(Changeset, buf).hash : null
  }

  async pathSeq(p) {
    const buf = await this.get(keys.path(p))
    return buf ? c.decode(PathRecord, buf).seq : 0
  }

  outcome(node, o) {
    this.put(keys.op(node.key, node.length), c.encode(Outcome, o))
  }

  async flush() {
    if (this.pending.size === 0) return
    const w = this.view.write()
    for (const { key, value } of this.pending.values()) {
      if (value === null) w.tryDelete(key)
      else w.tryPut(key, value)
    }
    await w.flush()
    this.pending.clear()
  }
}

module.exports = {
  apply,
  lineDelta,
  OP_LAND,
  OP_ADD_WRITER,
  OP_PROPOSE,
  OP_REVIEW,
  OP_ACK,
  OP_REMOVE_WRITER,
  OP_ITEM,
  ITEM_NEW,
  ITEM_CLAIM,
  ITEM_RELEASE,
  ITEM_TAKE,
  ITEM_HEARTBEAT,
  ITEM_DONE,
  ITEM_DROP,
  ACCEPTED,
  CONFLICT,
  STALE_BASE,
  INVALID,
  NEEDS_REVIEW,
  STALE_REVIEW,
  STATUS,
  APPROVE,
  CHANGES,
  COMMENT,
  VERDICTS,
  PROP_OPEN,
  PROP_APPROVED,
  PROP_LANDED,
  PROP_STATUS,
  POLICY_PATH
}
