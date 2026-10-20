// Review as signals: handles, Ask (proposals + quorum approvals), Show (requests), and the
// opt-in /.hsreview policy that apply enforces deterministically.
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const keys = require('../lib/keys')

const put = (path, s) => ({ path, content: b4a.from(s) })

test('handles are unique and resolve both ways', async (t) => {
  const { a, b, c } = await team(t)
  t.is(await a.handleOf(b.writerKey), 'b1')
  t.alike(await c.keyOf('a1'), a.writerKey)
  const dup = await a.addWriter(c.writerKey, { handle: 'b1' })
  t.is(dup.outcome.status, 'invalid')
  t.ok(/handle taken/.test(dup.outcome.reason))
  const bad = await a.addWriter(c.writerKey, { handle: 'Not OK!' })
  t.is(bad.outcome.status, 'invalid')
})

test('Ask: a proposal lands only once approved by someone other than its author', async (t) => {
  const { a, b, settle } = await team(t)

  const wb = await b.workspace('wb')
  await wb.commit([put('/f.js', 'one\n')])
  const p = await wb.propose({ message: 'add f', reviewers: ['a1'] })
  t.is(p.outcome.status, 'accepted')
  const id = p.outcome.proposal
  await settle()

  let res = await wb.land({ message: 'add f' })
  t.is(res.outcome.status, 'needs-review', 'unapproved proposal does not land')
  t.ok(/0\/1 approvals/.test(res.outcome.reason))

  const prop = await b.proposal(id)
  const self = await b.review({ proposal: id, verdict: 1, hash: prop.hash })
  t.is(self.outcome.status, 'accepted')
  t.is((await b.proposal(id)).approvals, 0, 'self-approval does not count')

  await settle()
  t.is((await a.proposal(id)).statusName, 'open')
  const ok = await a.review({ proposal: id, verdict: 1, hash: prop.hash, comment: 'lgtm' })
  t.is(ok.outcome.status, 'accepted')
  t.is((await a.proposal(id)).statusName, 'approved')
  await settle()

  res = await wb.land({ message: 'add f' })
  t.is(res.outcome.status, 'accepted', 'approved proposal lands')
  const cs = await b.changeset(res.outcome.seq)
  t.is(cs.proposal, id)
  t.is((await b.proposal(id)).statusName, 'landed')
  t.is(wb.state.proposal, 0, 'workspace no longer tracks it')

  const types = (await b.events()).map((e) => e.type).filter((type) => type !== 'settled')
  t.alike(types, ['proposal', 'review', 'review', 'approved', 'landed'])
})

test('a new revision makes earlier reviews stale; quorum counts distinct writers', async (t) => {
  const { a, b, c, settle } = await team(t)

  const wb = await b.workspace('wb')
  await wb.commit([put('/g.js', 'g1\n')])
  const id = (await wb.propose({ reviewers: ['a1', 'c1'], quorum: 2 })).outcome.proposal
  await settle()
  const first = (await a.proposal(id)).hash

  await wb.commit([put('/g.js', 'g2\n')])
  t.is((await wb.propose({})).outcome.proposal, id, 'same proposal, updated')
  await settle()
  const p = await a.proposal(id)
  t.is(p.revision, 1)
  t.is(p.quorum, 2, 'quorum kept across revisions')

  const stale = await a.review({ proposal: id, verdict: 1, hash: first })
  t.is(stale.outcome.status, 'stale-review', 'approval of an old revision is rejected')

  await a.review({ proposal: id, verdict: 1, hash: p.hash })
  await settle()
  t.is((await c.proposal(id)).statusName, 'open', '1/2')
  await c.review({ proposal: id, verdict: 1, hash: p.hash })
  await settle()
  t.is((await b.proposal(id)).statusName, 'approved', '2/2')
  t.is((await wb.land()).outcome.status, 'accepted')
})

test("an approval survives merging teammates' changes into the proposal on the way to land", async (t) => {
  const { a, b, settle } = await team(t)

  const seed = await a.workspace('seed')
  await seed.commit([put('/x.txt', 'one\ntwo\nthree\n')])
  await seed.land()
  await settle()

  const wb = await b.workspace('wb')
  await wb.commit([put('/x.txt', 'ONE\ntwo\nthree\n')])
  const id = (await wb.propose({ reviewers: ['a1'] })).outcome.proposal
  await settle()
  await a.review({ proposal: id, verdict: 1, hash: (await a.proposal(id)).hash })

  // meanwhile main changes the same file; b's land conflicts, sync merges, content differs
  const wa = await a.workspace('wa')
  await wa.commit([put('/x.txt', 'one\ntwo\nTHREE\n')])
  await wa.land()
  await settle()

  await settle()
  const res = await wb.land({ rebase: 1 })
  t.is(res.outcome.status, 'accepted', "only main's change was merged in: still approved")
  t.is((await b.changeset(res.outcome.seq)).proposal, id)

  // anything else that changed after review needs review again
  const wc = await b.workspace('wc')
  await wc.commit([put('/y.txt', 'y\n')])
  const id2 = (await wc.propose({ reviewers: ['a1'] })).outcome.proposal
  await settle()
  await a.review({ proposal: id2, verdict: 1, hash: (await a.proposal(id2)).hash })
  await settle()
  await wc.commit([put('/y.txt', 'y changed by the author\n')])
  const again = await wc.land()
  t.is(again.outcome.status, 'needs-review')
  t.ok(/content changed since P\d+ was reviewed/.test(again.outcome.reason))
})

test('.hsreview-protected paths: approvals bind to the approved lines (TO-FIVE #17)', async (t) => {
  const { a, b, settle } = await team(t)
  const wa = await a.workspace('wa')
  await wa.commit([
    put('/.hsreview', 'contract.md approvals=1\n'),
    put('/contract.md', 'one\ntwo\nthree\n')
  ])
  t.is((await wa.land()).outcome.status, 'accepted')
  await settle()

  const wb = await b.workspace('wb')
  await wb.commit([put('/contract.md', 'ONE\ntwo\nthree\n')])
  const id = (await wb.propose({ reviewers: ['a1'] })).outcome.proposal
  await settle()
  await a.review({ proposal: id, verdict: 1, hash: (await a.proposal(id)).hash })

  // a's own approved change to the protected file lands through a proposal of its own
  const wa2 = await a.workspace('wa2')
  await wa2.commit([put('/contract.md', 'one\ntwo\nTHREE\n')])
  const pa = (await wa2.propose({ reviewers: ['b1'] })).outcome.proposal
  await settle()
  await b.review({ proposal: pa, verdict: 1, hash: (await b.proposal(pa)).hash })
  await settle()
  t.is((await wa2.land()).outcome.status, 'accepted')
  await settle()

  // b's land merges a's approved change in: b still adds and removes exactly what was approved
  const res = await wb.land({ rebase: 1 })
  t.is(res.outcome.status, 'accepted', 'a teammate approved lines merging in keep it approved')
  await settle()

  // a line nobody approved still needs review
  const wb2 = await b.workspace('wb2')
  await wb2.commit([put('/contract.md', 'ONE\nTWO\nTHREE\n')])
  const id2 = (await wb2.propose({ reviewers: ['a1'] })).outcome.proposal
  await settle()
  await a.review({ proposal: id2, verdict: 1, hash: (await a.proposal(id2)).hash })
  await settle()
  await wb2.commit([put('/contract.md', 'ONE\nTWO\nTHREE\nfour\n')])
  const sneaky = await wb2.land()
  t.is(sneaky.outcome.status, 'needs-review', 'an unapproved line needs review')
})

test('Show: a land can ask teammates to review it afterwards', async (t) => {
  const { a, b, settle } = await team(t)
  const wb = await b.workspace('wb')
  await wb.commit([put('/pricing.js', 'p\n')])
  const res = await wb.land({ message: 'tweak pricing', reviewers: ['a1', 'nobody'] })
  t.is(res.outcome.status, 'accepted', 'Show lands immediately')
  await settle()

  const reqs = await a.requests()
  t.is(reqs.length, 1)
  t.is(reqs[0].seq, res.outcome.seq)
  t.alike(reqs[0].reviewers, [a.writerKey], 'unknown handles are ignored')

  const r = await a.review({ seq: res.outcome.seq, verdict: 2, comment: 'rounding is off' })
  t.is(r.outcome.status, 'accepted')
  await settle()
  const reviews = await b.reviews(keys.TARGET_CHANGESET, res.outcome.seq)
  t.is(reviews[0].verdict, 2)
  t.is(reviews[0].comment, 'rounding is off')
  t.alike(
    (await b.events()).map((e) => e.type).filter((type) => type !== 'settled'),
    ['request', 'review']
  )
})

test('.hsreview: protected paths land only through approved proposals, including itself', async (t) => {
  const { a, b, settle } = await team(t)

  const wa = await a.workspace('wa')
  await wa.commit([put('/.hsreview', 'src/*.js approvals=1 reviewers=a1\n.hsreview approvals=1\n')])
  t.is((await wa.land()).outcome.status, 'accepted', 'the first policy lands freely')
  await settle()
  t.ok((await b.policyText()).includes('src/*.js'))

  const wb = await b.workspace('wb')
  await wb.commit([put('/src/s.js', 's\n'), put('/README.md', 'r\n')])
  let res = await wb.land()
  t.is(res.outcome.status, 'needs-review')
  t.ok(res.outcome.reason.includes('/src/s.js'))

  const id = (await wb.propose({ reviewers: ['a1'] })).outcome.proposal
  await settle()
  await a.review({ proposal: id, verdict: 1, hash: (await a.proposal(id)).hash })
  await settle()
  res = await wb.land()
  t.is(res.outcome.status, 'accepted', 'approved by a listed reviewer')

  // the policy protects itself
  await wb.sync()
  await wb.commit([put('/.hsreview', '')])
  res = await wb.land()
  t.is(res.outcome.status, 'needs-review', 'changing the policy needs review too')
})

async function team(t) {
  const repos = []
  for (let i = 0; i < 3; i++) {
    const store = new Corestore(await tmp(t))
    const repo = new Repo(store, { key: i === 0 ? null : repos[0].key })
    await repo.ready()
    repos.push(repo)
    t.teardown(async () => {
      await repo.close()
      await store.close()
    })
  }
  const [a, b, c] = repos
  for (const other of [b, c]) {
    const s1 = a.store.replicate(true)
    const s2 = other.store.replicate(false)
    s1.pipe(s2).pipe(s1)
  }
  const settle = async () => {
    let last = null
    let stable = 0
    for (let i = 0; i < 300 && stable < 3; i++) {
      for (const r of repos) await r.update()
      const metas = await Promise.all(
        repos.map((r) => r.eventCount().then((n) => n + ':' + r.head().length))
      )
      const ws = await Promise.all(repos.map((r) => r.meta()))
      const id = ws.map((m) => m.seq).join(',') + '|' + metas.map((m) => m.split(':')[0]).join(',')
      const same =
        ws.every((m) => m.seq === ws[0].seq) &&
        new Set(metas.map((m) => m.split(':')[0])).size === 1
      stable = same && id === last ? stable + 1 : 0
      last = id
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  await a.addWriter(a.writerKey, { indexer: true, handle: 'a1' })
  await a.addWriter(b.writerKey, { handle: 'b1' })
  await a.addWriter(c.writerKey, { handle: 'c1' })
  await settle()
  t.ok(b.writable && c.writable, 'team ready')
  return { a, b, c, settle }
}
