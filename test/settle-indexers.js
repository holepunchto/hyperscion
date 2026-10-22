// Settlement with several indexers. The rule apply uses (every indexer has seen it) must never
// let a settled changeset be reordered. A shadow "majority of indexers" rule is computed from
// the same seen records: under autobee's ordering (indexers' concurrent nodes tie on weight
// and fall back to timestamps) an indexer outside the majority can still sort a node it made
// without seeing a land ahead of that land, so the majority rule is expected to break.
//
//   HS_SETTLE_SEED=<n> HS_SETTLE_ROUNDS=<n> brittle-bare test/settle-indexers.js
//   HS_SETTLE_REQUIRE_MAJORITY_FAIL=1 also asserts the majority rule was violated
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const process = require('bare-process')
const Repo = require('../lib/repo')

const SEED = Number(process.env.HS_SETTLE_SEED || 7)
const ROUNDS = Number(process.env.HS_SETTLE_ROUNDS || 30)
const HOT = ['/a.txt', '/b.txt', '/c.txt']

test(`several indexers: settled changesets are never reordered (seed ${SEED}, ${ROUNDS} rounds)`, async (t) => {
  t.timeout(600_000)
  let state = SEED
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const pick = (list) => list[Math.floor(rand() * list.length)]

  const repos = []
  for (let i = 0; i < 5; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : repos[0].key })
    await repo.ready()
    repos.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  const indexers = repos.slice(0, 3)
  const agents = repos.slice(3)

  const links = new Map()
  const linkId = (x, y) => repos.indexOf(x) + '-' + repos.indexOf(y)
  const connect = (x, y) => {
    const id = linkId(x, y)
    if (links.has(id)) return
    const s1 = x.store.replicate(true)
    const s2 = y.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    links.set(id, [s1, s2])
  }
  const disconnect = (x, y) => {
    const pair = links.get(linkId(x, y))
    if (!pair) return
    pair[0].destroy()
    pair[1].destroy()
    links.delete(linkId(x, y))
  }
  const pairs = []
  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) pairs.push([repos[i], repos[j]])
  }
  const allUp = () => pairs.forEach(([x, y]) => connect(x, y))
  const pump = async (n = 10) => {
    for (let i = 0; i < n; i++) {
      for (const r of repos) await r.update()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  allUp()
  for (const ix of indexers.slice(1)) await repos[0].addWriter(ix.writerKey, { indexer: true })
  for (const a of agents) await repos[0].addWriter(a.writerKey)
  await pump(40)
  t.ok(
    repos.every((r) => r.writable),
    'team ready'
  )
  t.is((await agents[0].indexers()).length, 3, 'three indexers')

  const wss = await Promise.all(agents.map((a, i) => a.workspace('w' + i)))
  for (const ws of wss) ws.io = { timeout: 300 }

  const claims = { all: new Map(), majority: new Map() }
  const violations = { all: 0, majority: 0 }
  let flips = 0
  const provisional = new Map()
  let n = 0

  const record = (rule, seq, hash) => {
    const prev = claims[rule].get(seq)
    if (!prev) return claims[rule].set(seq, hash)
    if (!b4a.equals(prev, hash)) {
      violations[rule]++
      t.comment(`${rule} rule: settled #${seq} changed (seed ${SEED})`)
    }
  }

  const observe = async () => {
    for (const r of repos) {
      const meta = await r.meta()
      // the rule apply uses
      for (let seq = 1; seq <= (meta.settled || 0); seq++) {
        const cs = await r.changeset(seq)
        if (cs) record('all', seq, cs.hash)
      }
      // shadow: the point a majority (2 of 3) of indexers have seen
      const seen = []
      for (const k of await r.indexers()) seen.push(await r.seenBy(k))
      seen.sort((a, b) => b - a)
      const majority = Math.min(seen[Math.floor(seen.length / 2)] || 0, meta.seq)
      for (let seq = 1; seq <= majority; seq++) {
        const cs = await r.changeset(seq)
        if (cs) record('majority', seq, cs.hash)
      }
      for (let seq = (meta.settled || 0) + 1; seq <= meta.seq; seq++) {
        const cs = await r.changeset(seq)
        if (!cs) continue
        const key = repos.indexOf(r) + ':' + seq
        const prev = provisional.get(key)
        if (prev && !b4a.equals(prev, cs.hash)) flips++
        provisional.set(key, cs.hash)
      }
    }
  }

  for (let round = 0; round < ROUNDS; round++) {
    // random partition; an indexer is sometimes cut off from everyone
    for (const [x, y] of pairs) {
      if (rand() < 0.45) connect(x, y)
      else disconnect(x, y)
    }
    if (rand() < 0.35) {
      const lone = pick(indexers)
      for (const r of repos) if (r !== lone) disconnect(lone, r)
    }

    const ops = 1 + Math.floor(rand() * 4)
    for (let i = 0; i < ops; i++) {
      const k = Math.floor(rand() * agents.length)
      const ws = wss[k]
      if (rand() < 0.5) await ws.sync().catch(() => {})
      await ws.commit([{ path: pick(HOT), content: b4a.from(`round ${round} op ${n++} by a${k}`) }])
      await ws.land({ message: `r${round}` }).catch(() => {})
    }
    // indexers ack whatever they have seen, cut off or not
    for (const ix of indexers) if (rand() < 0.6) await ix.ack()
    await pump(1 + Math.floor(rand() * 8))
    await observe()
  }

  allUp()
  for (let i = 0; i < 3; i++) {
    for (const ix of indexers) await ix.ack()
    await pump(30)
  }
  await observe()

  const heads = await Promise.all(repos.map((r) => r.meta()))
  t.ok(
    heads.every((m) => m.seq === heads[0].seq && b4a.equals(m.hash, heads[0].hash)),
    'all peers converged'
  )
  for (const rule of ['all', 'majority']) {
    for (const [seq, hash] of claims[rule]) {
      const cs = await repos[0].changeset(seq)
      if (!cs || !b4a.equals(cs.hash, hash)) violations[rule]++
    }
  }

  t.comment(
    `seed ${SEED}: ${heads[0].seq} changesets, settled #${heads[0].settled || 0}, ` +
      `claims all=${claims.all.size} majority=${claims.majority.size}, ` +
      `provisional reorders ${flips}, violations all=${violations.all} majority=${violations.majority}`
  )
  t.ok(claims.all.size > 0, 'some lands settled during the run')
  t.is(violations.all, 0, 'every-indexer rule: no settled changeset was ever reordered')
  if (process.env.HS_SETTLE_REQUIRE_MAJORITY_FAIL) {
    t.ok(violations.majority > 0, 'the majority rule was violated (quorum is unsafe here)')
  }
})
