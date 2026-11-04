// The gate for finality: under random partitions and concurrent lands on hot paths, a
// changeset that any peer ever considered settled (all indexers have seen it) must never be
// reordered or replaced. A control tracks the stricter all-writers rule from the same records.
//
//   HS_SETTLE_SEED=<n> HS_SETTLE_ROUNDS=<n> brittle-bare test/settle-property.js
//   HS_SETTLE_TOPOLOGY=handover|hub   the hub granted by a heavy genesis that steps down (what
//   `hs init --hub` builds), or by a light owner (repos from milestone 7 to docs/FINALITY.md)
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const process = require('bare-process')
const Repo = require('../lib/repo')
const keys = require('../lib/keys')
const { getEncoding } = require('../lib/schema/spec')

const PathRecord = getEncoding('@hs/path')
// seed 12 produces several real reorders; sweep others with HS_SETTLE_SEED
const SEED = Number(process.env.HS_SETTLE_SEED || 12)
const ROUNDS = Number(process.env.HS_SETTLE_ROUNDS || 30)
const HOT = ['/a.txt', '/b.txt', '/c.txt']
const TOPOLOGIES = process.env.HS_SETTLE_TOPOLOGY
  ? [process.env.HS_SETTLE_TOPOLOGY]
  : ['genesis', 'handover', 'hub']

for (const TOPOLOGY of TOPOLOGIES) {
  test(`settled changesets are never reordered (${TOPOLOGY}, seed ${SEED}, ${ROUNDS} rounds)`, async (t) => {
    t.timeout(600_000)
    let state = SEED
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const pick = (list) => list[Math.floor(rand() * list.length)]

    const open = async (opts) => {
      const store = new Corestore(await tmp(t))
      const repo = new Repo(store, opts)
      await repo.ready()
      t.teardown(async () => {
        await repo.close()
        await store.close()
      })
      return repo
    }
    // 'genesis': the hub is the heavy bootstrap writer (repos before milestone 7).
    // 'handover': what `hs init --hub` builds (docs/FINALITY.md), a heavy genesis that grants the
    // hub weight 2 and steps down. 'hub': a light repo (milestone 7 until that fix), a light
    // owner (weight 1) that adds the hub; it steps down too, so settlement (every writer, since
    // the hub doesn't outweigh anyone) doesn't wait for it
    const weight = TOPOLOGY === 'hub' ? 1 : 2
    const owner = TOPOLOGY === 'genesis' ? null : await open({ bootstrapWeight: weight })
    const repos = []
    for (let i = 0; i < 4; i++) {
      const key = owner ? owner.key : i === 0 ? null : repos[0].key
      repos.push(await open({ key, bootstrapWeight: weight }))
    }
    const [hub, ...agents] = repos

    // links between every pair, toggled to make partitions
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
      const id = linkId(x, y)
      const pair = links.get(id)
      if (!pair) return
      pair[0].destroy()
      pair[1].destroy()
      links.delete(id)
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
    if (owner) {
      // the owner admits the hub (as indexer) and the agents, then goes away
      const ownerLinks = repos.map((r) => {
        const s1 = owner.store.replicate(true)
        const s2 = r.store.replicate(false)
        s1.pipe(s2).pipe(s1)
        return [s1, s2]
      })
      await owner.addWriter(hub.writerKey, { indexer: true })
      for (const a of agents) await owner.addWriter(a.writerKey, { indexer: false })
      for (let i = 0; i < 60 && !repos.every((r) => r.writable); i++) {
        await owner.update()
        await pump(1)
      }
      await owner.removeWriter(owner.writerKey)
      for (let i = 0; i < 20; i++) {
        await owner.update()
        await pump(1)
      }
      for (const [s1, s2] of ownerLinks) {
        s1.destroy()
        s2.destroy()
      }
    } else {
      for (const a of agents) await hub.addWriter(a.writerKey, { indexer: false })
    }
    await pump(30)
    t.ok(
      agents.every((a) => a.writable),
      'team ready'
    )

    const wss = await Promise.all(agents.map((a, i) => a.workspace('w' + i)))
    // partitions make teammates' content unreachable at times: fail reads fast, like the CLI does
    for (const ws of wss) ws.io = { timeout: 300 }
    const observed = new Map() // seq -> hash of a settled changeset, as first seen settled
    const observedAll = new Map() // same for the all-writers control rule
    const provisional = new Map() // seq -> hash while not yet settled, to count real reorders
    let flips = 0
    let violations = 0
    let controlViolations = 0
    let maxSettled = 0
    let n = 0

    const record = (map, seq, hash, label) => {
      const prev = map.get(seq)
      if (!prev) return map.set(seq, hash)
      if (!b4a.equals(prev, hash)) {
        if (label === 'indexer') violations++
        else controlViolations++
        t.comment(`${label} rule violated: settled #${seq} changed (seed ${SEED})`)
      }
    }

    const observe = async () => {
      for (const r of repos) {
        const meta = await r.meta()
        const settled = meta.settled || 0
        maxSettled = Math.max(maxSettled, settled)
        for (let seq = 1; seq <= settled; seq++) {
          const cs = await r.changeset(seq)
          if (cs) record(observed, seq, cs.hash, 'indexer')
        }
        for (let seq = settled + 1; seq <= meta.seq; seq++) {
          const cs = await r.changeset(seq)
          if (!cs) continue
          const key = repos.indexOf(r) + ':' + seq
          const prev = provisional.get(key)
          if (prev && !b4a.equals(prev, cs.hash)) flips++
          provisional.set(key, cs.hash)
        }
        // control: lowest point every writer has been seen to reach
        let all = Infinity
        for (const w of repos) {
          const node = await r.main.view.get(keys.seen(w.writerKey))
          all = Math.min(all, node ? c.decode(PathRecord, node.value).seq : 0)
        }
        for (let seq = 1; seq <= Math.min(all, meta.seq); seq++) {
          const cs = await r.changeset(seq)
          if (cs) record(observedAll, seq, cs.hash, 'all-writers')
        }
      }
    }

    for (let round = 0; round < ROUNDS; round++) {
      // random partition, the hub is sometimes cut off entirely
      for (const [x, y] of pairs) {
        if (rand() < 0.45) connect(x, y)
        else disconnect(x, y)
      }
      if (rand() < 0.25) for (const a of agents) disconnect(hub, a)

      // concurrent lands on a small hot set from random agents, sometimes after a sync
      const ops = 1 + Math.floor(rand() * 4)
      for (let i = 0; i < ops; i++) {
        const k = Math.floor(rand() * agents.length)
        const ws = wss[k]
        if (rand() < 0.5) await ws.sync().catch(() => {})
        await ws.commit([
          { path: pick(HOT), content: b4a.from(`round ${round} op ${n++} by a${k}`) }
        ])
        await ws.land({ message: `r${round}` }).catch(() => {})
      }
      if (rand() < 0.7) await hub.ack()
      await pump(1 + Math.floor(rand() * 8))
      await observe()
    }

    // heal everything, let the hub ack, converge, and check every settled claim still holds
    allUp()
    for (let i = 0; i < 3; i++) {
      await hub.ack()
      await pump(30)
    }
    await observe()

    const heads = await Promise.all(repos.map((r) => r.meta()))
    t.ok(
      heads.every((m) => m.seq === heads[0].seq && b4a.equals(m.hash, heads[0].hash)),
      'all peers converged'
    )
    for (const [seq, hash] of observed) {
      const cs = await hub.changeset(seq)
      if (!cs || !b4a.equals(cs.hash, hash)) violations++
    }

    t.comment(
      `seed ${SEED}: ${heads[0].seq} changesets, settled up to #${heads[0].settled || 0}, ` +
        `${observed.size} settled claims observed (max settled seen #${maxSettled}), ` +
        `control claims ${observedAll.size}, provisional changesets reordered: ${flips}`
    )
    if (process.env.HS_SETTLE_REQUIRE_FLIPS) t.ok(flips > 0, 'the run produced real reorders')
    t.ok(observed.size > 0, 'some lands actually settled during the run')
    t.is(violations, 0, 'indexer rule: no settled changeset was ever reordered')
    t.is(controlViolations, 0, 'all-writers control: none either')
  })
}
