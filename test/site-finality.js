// A land the hub has made final stays where it is when a site that couldn't reach the hub
// comes back with lands of its own (q0bs: a3's final #3 was undone by site B's chain).
//
// The hub outweighs the agents in autobee's order since `init --hub` hands over from a heavy
// throwaway genesis (docs/FINALITY.md); before, its ack pinned nothing and this failed.
const test = require('brittle')
const { team, waitFor, sleep } = require('./helpers/team')

test('site split: a final land is not reordered by the other site on heal', async (t) => {
  t.timeout(240_000)
  const tm = await team(t, { agents: ['a1', 'a2', 'a3'], files: { 'a.txt': 'a\n' } })
  for (const a of ['a1', 'a2', 'a3']) await tm.as(a, ['sync'])
  await tm.split(['a1', 'a2'])
  const feeds = ['a1', 'a2'].map((a) => tm.bgAs(a, ['watch', '--json']))
  await sleep(3000)
  tm.write('a1', 'b.txt', 'site b\n')
  const b = await tm.as('a1', ['land', '-m', 'site b'])
  t.ok(/provisional/.test(b.stdout), 'site B has no hub: ' + b.stdout)
  tm.write('a3', 'c.txt', 'site a\n')
  const a = await tm.as('a3', ['land', '-m', 'site a'])
  t.ok(/final/.test(a.stdout), 'site A: final at the hub: ' + a.stdout)
  const seq = Number(a.stdout.match(/landed #(\d+)/)[1])
  const before = (await tm.as('a3', ['log'])).stdout.match(new RegExp(`^#${seq} (\\S+) a3`, 'm'))[1]
  for (const f of feeds) await f.stop()
  tm.heal(['a1', 'a2'])
  await waitFor(async () => {
    await tm.as('a1', ['sync'])
    return tm.read('a1', 'c.txt') !== null
  }, 60_000)
  const log = await tm.as('a3', ['log'])
  await tm.as('a3', ['sync'])
  const after = await tm.as('a3', ['log'])
  t.ok(
    new RegExp(`^#${seq} ${before} a3 .*\\[final\\]`, 'm').test(after.stdout),
    `a3's final land is still #${seq}:\n${after.stdout}\n(before: ${log.stdout})`
  )
  const st = await tm.as('a3', ['status'])
  t.absent(/undone|conflict/i.test(st.stdout + st.stderr), st.stdout)
})

// Two provisional lands on site B, both undone when the sites meet: sync brings both back,
// not only the last (q0bs-min-3: a1's code land vanished, only its NOTES land came back)
test('site split: every undone land comes back, not only the last', async (t) => {
  t.timeout(240_000)
  const tm = await team(t, { agents: ['a1', 'a2', 'a3'], files: { 'a.txt': 'a\n' } })
  for (const a of ['a1', 'a2', 'a3']) await tm.as(a, ['sync'])
  await tm.split(['a1', 'a2'])
  const feeds = ['a1', 'a2'].map((a) => tm.bgAs(a, ['watch', '--json']))
  await sleep(3000)
  tm.write('a1', 'a.txt', 'a\nsite b edit\n')
  tm.write('a1', 'code.txt', 'the code\n')
  await tm.as('a1', ['land', '-m', 'code'])
  tm.write('a1', 'notes.txt', 'the notes\n')
  await tm.as('a1', ['land', '-m', 'notes'])
  tm.write('a3', 'a.txt', 'site a edit\na\n')
  tm.write('a3', 'code.txt', 'their code\n')
  tm.write('a3', 'c.txt', 'site a\n')
  const a = await tm.as('a3', ['land', '-m', 'site a'])
  t.ok(/final/.test(a.stdout), a.stdout)
  for (const f of feeds) await f.stop()
  tm.heal(['a1', 'a2'])
  const syncs = []
  await waitFor(async () => {
    const r = await tm.as('a1', ['sync'])
    syncs.push(r.stdout + r.stderr)
    return tm.read('a1', 'c.txt') !== null
  }, 60_000)
  // both lands are back in a1's files: merged where they can be (a.txt), in conflict where
  // both sides added the same file (code.txt), never silently dropped
  t.is(tm.read('a1', 'notes.txt'), 'the notes\n', 'the last land is back')
  t.ok(
    /<<<<<<<[\s\S]*the code/.test(tm.read('a1', 'code.txt') || ''),
    'the one before it, in conflict'
  )
  // and it says who landed those files first, offering to keep theirs (q0bs: a duplicate)
  const said = syncs.join('\n')
  t.ok(/conflicts with #\d+ a3 in \/code\.txt/.test(said), said)
  t.ok(/hs restore \/code\.txt/.test(said), 'offers keeping theirs')
  const merged = tm.read('a1', 'a.txt') || ''
  t.ok(
    /site a edit/.test(merged) && /site b edit/.test(merged),
    'a.txt merges both edits: ' + merged
  )
})

// Restoring my undone land replays my changes only, not a teammate's provisional land I synced
// after mine (q0bs-min-3: a2's sync showed a1's undone code as a2's own, and offered to land it)
test("site split: restoring my land doesn't replay a teammate's land as mine", async (t) => {
  t.timeout(240_000)
  const tm = await team(t, { agents: ['a1', 'a2', 'a3'], files: { 'a.txt': 'a\n' } })
  for (const a of ['a1', 'a2', 'a3']) await tm.as(a, ['sync'])
  await tm.split(['a1', 'a2'])
  const feeds = ['a1', 'a2'].map((a) => tm.bgAs(a, ['watch', '--json']))
  await sleep(3000)
  tm.write('a2', 'notes.txt', 'a2 notes\n')
  await tm.as('a2', ['land', '-m', 'a2 notes'])
  tm.write('a1', 'code.txt', 'a1 code\n')
  await tm.as('a1', ['land', '-m', 'a1 code'])
  await waitFor(async () => {
    await tm.as('a2', ['sync'])
    return tm.read('a2', 'code.txt') !== null
  }, 30_000)
  tm.write('a3', 'code.txt', 'a3 code\n')
  t.ok(/final/.test((await tm.as('a3', ['land', '-m', 'a3 code'])).stdout))
  for (const f of feeds) await f.stop()
  tm.heal(['a1', 'a2'])
  await waitFor(async () => {
    await tm.as('a2', ['sync'])
    return tm.read('a2', 'notes.txt') !== null && /a3 code/.test(tm.read('a2', 'code.txt') || '')
  }, 60_000).catch(() => {})
  const synced = await tm.as('a2', ['sync'])
  t.is(
    tm.read('a2', 'code.txt'),
    'a3 code\n',
    "a2's files take main's code.txt, not a1's undone one"
  )
  t.absent(
    /code\.txt/.test(synced.stdout + synced.stderr),
    "code.txt isn't a2's change: " + synced.stdout
  )
  await waitFor(async () => {
    await tm.as('a3', ['sync'])
    return tm.read('a3', 'notes.txt') !== null
  }, 30_000).catch(() => {})
  t.is(tm.read('a3', 'notes.txt'), 'a2 notes\n', "a2's own land is back on main")
  t.is(tm.read('a3', 'code.txt'), 'a3 code\n', 'and a3 keeps its code')
})

// A split longer than a claim's lease (what an hours-long split adds over a short one): a
// claimant whose feed runs keeps its claim and still leads when the sites meet; one with no
// feed and no land or sync lapses, and the other side's claim leads. HS_CLAIM_TTL_MS
// shortens the 20-minute lease to 20 s.
test('site split longer than the claim lease: a running feed keeps a claim live', async (t) => {
  t.timeout(300_000)
  const tm = await team(t, {
    agents: ['a1', 'a2', 'a3'],
    files: { 'a.txt': 'a\n' },
    env: { HS_CLAIM_TTL_MS: '20000' }
  })
  const owner = require('bare-path').join(tm.dir, 'owner')
  const made = []
  for (const title of ['CR-kept: with a feed', 'CR-lapsed: without one']) {
    const r = await tm.hs(owner, ['item', 'new', title], 'owner')
    made.push(r.stdout.match(/item (C[0-9a-f]{6})/)[1])
  }
  const [kept, lapsed] = made
  for (const a of ['a1', 'a2', 'a3']) await tm.as(a, ['sync'])
  await tm.split(['a1', 'a2'])
  const feed = tm.bgAs('a1', ['watch', '--json'])
  const quiet = tm.bgAs('a2', ['watch', '--json'])
  const zfeed = tm.bgAs('a3', ['watch', '--json'])
  await sleep(3000)
  t.ok(/you lead/.test((await tm.as('a1', ['claim', kept])).stdout), 'a1 leads kept on site B')
  t.ok(/you lead/.test((await tm.as('a2', ['claim', lapsed])).stdout), 'a2 leads lapsed on B')
  await quiet.stop() // a2 goes quiet: no feed, no land, no sync
  await sleep(2000)
  for (const id of [kept, lapsed]) {
    t.ok(/you lead/.test((await tm.as('a3', ['claim', id])).stdout), 'a3 leads on site A')
  }
  await sleep(30_000) // longer than the lease
  // the sites meet: a1's feed restarts on the main network (a feed process would reconnect
  // by itself; this one has to be restarted to change DHTs) and picks up its renewals from
  // this machine; a3's feed never moved
  await feed.stop()
  tm.heal(['a1', 'a2'])
  tm.bgAs('a1', ['watch', '--json'])
  let board = ''
  await waitFor(async () => {
    board = (await tm.as('a3', ['claims'])).stdout
    return /lead a1/.test(board)
  }, 15_000).catch(() => {})
  await zfeed.stop()
  const block = (id) => board.slice(board.indexOf(id)).split('\n').slice(0, 3).join('\n')
  t.ok(/lead a1/.test(block(kept)), 'kept: a1 still leads, renewed by its feed:\n' + board)
  t.ok(/lead a3/.test(block(lapsed)), "lapsed: a2's claim lapsed, a3 leads:\n" + board)
})
