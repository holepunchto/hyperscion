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
  await waitFor(async () => {
    await tm.as('a1', ['sync'])
    return tm.read('a1', 'c.txt') !== null
  }, 60_000)
  // both lands are back in a1's files: merged where they can be (a.txt), in conflict where
  // both sides added the same file (code.txt), never silently dropped
  t.is(tm.read('a1', 'notes.txt'), 'the notes\n', 'the last land is back')
  t.ok(
    /<<<<<<<[\s\S]*the code/.test(tm.read('a1', 'code.txt') || ''),
    'the one before it, in conflict'
  )
  const merged = tm.read('a1', 'a.txt') || ''
  t.ok(
    /site a edit/.test(merged) && /site b edit/.test(merged),
    'a.txt merges both edits: ' + merged
  )
})
