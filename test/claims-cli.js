// Claims through the real `hs` (docs/CLAIMS.md, phase 1): two agents claim the same item in
// the same instant and agree who leads; the board, land notes, completing an item with
// `land --item`, the 3-claim limit and releasing.
const test = require('brittle')
const { team } = require('./helpers/team')

test('claims: a race has one lead, the board shows it, a land completes the item', async (t) => {
  t.timeout(240_000)
  const tm = await team(t, { files: { 'src/a.js': 'a\n', 'NOTES.md': '# notes\n' } })
  await tm.as('a1', ['sync'])
  await tm.as('a2', ['sync'])

  const made = await tm.as('a1', [
    'item',
    'new',
    'CR-1: price per flight minute',
    '--paths',
    'src/pricing.js'
  ])
  t.is(made.code, 0, made.stderr)
  const id = made.stdout.match(/item (C[0-9a-f]{6})/)[1]

  // the race at time zero: both claim at once
  const [c1, c2] = await Promise.all([tm.as('a1', ['claim', id]), tm.as('a2', ['claim', id])])
  t.is(c1.code, 0, c1.stderr)
  t.is(c2.code, 0, c2.stderr)
  const leads = [c1, c2].filter((r) => /you lead/.test(r.stdout))
  t.is(leads.length, 1, 'exactly one leads:\n' + c1.stdout + '\n' + c2.stdout)
  const lead = leads[0] === c1 ? 'a1' : 'a2'
  const other = lead === 'a1' ? 'a2' : 'a1'
  const loser = leads[0] === c1 ? c2 : c1
  t.ok(
    new RegExp(`${lead} leads ${id} \\(claimed [0-9.]+ s before you\\)`).test(loser.stdout),
    loser.stdout
  )
  t.ok(
    new RegExp(`don't build it too\\. .*ask ${lead} for a piece`).test(loser.stdout),
    loser.stdout
  )

  // parts are the lead's to hand out (q2s-claims-1)
  const notMine = await tm.as(other, ['item', 'part', id, 'flight minutes helper'])
  t.not(notMine.code, 0)
  t.ok(
    new RegExp(`${lead} leads ${id}, so the parts are ${lead}'s to hand out`).test(notMine.stderr),
    notMine.stderr
  )
  const part = await tm.as(lead, ['item', 'part', id, 'flight minutes per stop (scheduler)'])
  t.is(part.code, 0, part.stderr)
  const partId = part.stdout.match(/item (C[0-9a-f]{6})/)[1]
  const again = await tm.as(lead, ['claim', id]) // the lead's verdict lists its parts
  t.ok(
    new RegExp(`part ${partId} "flight minutes per stop \\(scheduler\\)": nobody yet`).test(
      again.stdout
    ),
    again.stdout
  )
  t.ok(/you lead/.test(again.stdout), 'renewing keeps the lead')

  // an unclaimed item can't be split by just anyone; a look-alike --new gets a warning
  const fresh = await tm.as(lead, ['item', 'new', 'cache the distance matrix'])
  const freshId = fresh.stdout.match(/item (C[0-9a-f]{6})/)[1]
  const early = await tm.as(other, ['item', 'part', freshId, 'half of it'])
  t.ok(new RegExp(`nobody leads ${freshId} yet: claim it first`).test(early.stderr), early.stderr)
  const lookalike = await tm.as(other, ['claim', '--new', 'distance matrix cache for geo'])
  t.ok(
    new RegExp(`looks like ${freshId} "cache the distance matrix"`).test(lookalike.stderr),
    lookalike.stderr
  )

  const board = await tm.as(other, ['claims'])
  t.ok(new RegExp(`lead ${lead}`).test(board.stdout), board.stdout)
  t.ok(new RegExp(`also ${other}`).test(board.stdout), board.stdout)

  // the other lands into the item's paths: a note, not a refusal
  tm.write(other, 'src/pricing.js', '// mine\n')
  const noted = await tm.as(other, ['land', '-m', 'pricing too'])
  t.ok(/landed #\d+/.test(noted.stdout), noted.stdout + noted.stderr)
  t.ok(
    new RegExp(`note: /src/pricing.js is in ${lead}'s claim ${id}`).test(noted.stdout),
    noted.stdout
  )

  // the lead completes it
  await tm.as(lead, ['sync'])
  tm.write(lead, 'src/pricing.js', '// per minute\n')
  const done = await tm.as(lead, ['land', '-m', 'CR-1 per minute', '--item', id])
  t.ok(new RegExp(`completes ${id}`).test(done.stdout), done.stdout + done.stderr)
  const after = await tm.as(other, ['claims', '--all'])
  t.ok(new RegExp(`${id} .*\\[done #\\d+\\]`).test(after.stdout), after.stdout)
  const open = (await tm.as(other, ['claims'])).stdout
  t.absent(new RegExp(`^${id} `, 'm').test(open), 'the completed item is no longer open: ' + open)

  // 3 live claims at most; release frees one
  for (const x of (await tm.as('a1', ['claims'])).stdout.matchAll(
    /(C[0-9a-f]{6}) "[^"]*"[^\n]*\n\s+lead a1/g
  )) {
    await tm.as('a1', ['claim', x[1], '--release'])
  }
  for (const n of [1, 2, 3]) {
    t.is((await tm.as('a1', ['claim', '--new', `task ${n}`])).code, 0)
  }
  const fourth = await tm.as('a1', ['claim', '--new', 'task 4'])
  t.not(fourth.code, 0)
  t.ok(/already hold 3 claims/.test(fourth.stderr), fourth.stderr)
  const listed = (await tm.as('a1', ['claims'])).stdout
  const task1 = listed.match(/(C[0-9a-f]{6}) "task 1"/)[1]
  const released = await tm.as('a1', ['claim', task1, '--release'])
  t.ok(/released/.test(released.stdout), released.stdout)
  t.ok(/open: nobody on it/.test((await tm.as('a2', ['claims'])).stdout), 'open again')
})
