// Claims through the real `hs` (docs/CLAIMS.md, phase 1): two agents claim the same item in
// the same instant and agree who leads; the board, land notes, completing an item with
// `land --item`, the 3-claim limit and releasing.
const test = require('brittle')
const fs = require('bare-fs')
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

test('claims phase 2: a person approves a gated item from hs inbox, and its author lands it', async (t) => {
  t.timeout(240_000)
  const path = require('bare-path')
  const tm = await team(t, { agents: ['a1', 'ann'], files: { 'src/a.js': 'a\n' } })
  const owner = path.join(tm.dir, 'owner')
  const annKey = (await tm.as('ann', ['info'])).stdout.match(/^writer\s+(\S+)/m)[1]

  // only the team owner can say a writer is a person
  const notOwner = await tm.as('a1', ['add-writer', annKey, '--as', 'ann', '--human', '--offline'])
  t.ok(/only the team owner/.test(notOwner.stdout + notOwner.stderr), notOwner.stdout)
  const marked = await tm.hs(owner, ['add-writer', annKey, '--as', 'ann', '--human'], 'owner')
  t.ok(/add-writer: accepted/.test(marked.stdout), marked.stdout + marked.stderr)

  await tm.hs(owner, ['sync'], 'owner')
  fs.writeFileSync(
    path.join(owner, '.hsreview'),
    '/src/api/* approvals=1 reviewers=@humans\nitem kind=contract approvals=1 reviewers=@humans\n'
  )
  const policy = await tm.hs(owner, ['land', '-m', 'policy'], 'owner')
  t.ok(/landed #\d+/.test(policy.stdout), policy.stdout + policy.stderr)

  await tm.as('a1', ['sync'])
  const made = await tm.as('a1', [
    'item',
    'new',
    'rename the api',
    '--kind',
    'contract',
    '--paths',
    'src/api'
  ])
  t.is(made.code, 0, made.stderr)
  const id = made.stdout.match(/item (C[0-9a-f]{6})/)[1]
  const board = await tm.as('a1', ['claims'])
  t.ok(/needs 1 approval \(0\/1, from ann\)/.test(board.stdout), board.stdout)

  // an idea with no rule for it is just an item to claim
  const idea = await tm.as('a1', ['suggest', 'cache the distance matrix'])
  t.ok(/idea C[0-9a-f]{6} "cache the distance matrix"/.test(idea.stdout), idea.stdout)
  t.ok(/claim it to build it/.test(idea.stdout), idea.stdout)

  // the person's inbox lists it; a1's doesn't (its own item)
  const mine = await tm.as('a1', ['inbox'])
  t.ok(/nothing waiting on you/.test(mine.stdout), mine.stdout)
  const inbox = await tm.as('ann', ['inbox'])
  t.ok(
    new RegExp(`${id} \\[contract\\] "rename the api" by a1, .*needs 1 approval`).test(
      inbox.stdout
    ),
    inbox.stdout
  )
  const json = await tm.as('ann', ['inbox', '--json', '--offline'])
  t.is(JSON.parse(json.stdout.trim().split('\n')[0]).item, id, json.stdout)

  // a1's own approval doesn't count
  const self = await tm.as('a1', ['review', id, 'approve'])
  t.ok(/your own item/.test(self.stderr), self.stderr)
  t.ok(/needs 1 approval \(0\/1/.test(self.stdout), self.stdout)

  const approved = await tm.as('ann', ['inbox', '--approve-all'])
  t.ok(
    new RegExp(`${id} "rename the api": approved by you; approved \\(1/1\\)`).test(approved.stdout),
    approved.stdout + approved.stderr
  )
  const after = await tm.as('ann', ['inbox'])
  t.ok(/nothing waiting on you/.test(after.stdout), after.stdout)

  // without the item, the protected path is refused; --under lands a piece and keeps it open
  tm.write('a1', 'src/api/v1.js', '// v1\n')
  const refused = await tm.as('a1', ['land', '-m', 'api v1'])
  t.ok(/need.* approval/.test(refused.stdout + refused.stderr), refused.stdout + refused.stderr)
  t.ok(
    new RegExp(`hs land --item ${id}\` \\(or --under ${id}\\): ${id} is approved`).test(
      refused.stdout + refused.stderr
    ),
    'the hint names the approved item'
  )
  const piece = await tm.as('a1', ['land', '-m', 'api v1', '--under', id])
  t.ok(/landed #\d+/.test(piece.stdout), piece.stdout + piece.stderr)
  const open = await tm.as('a1', ['claims'])
  t.ok(new RegExp(`${id} "rename the api"`).test(open.stdout), open.stdout)
  t.absent(/\[done/.test(open.stdout), 'still open after --under')

  // the plan is approved: its author lands into the protected paths it names
  tm.write('a1', 'src/api/v2.js', '// v2\n')
  // a proposal made as a fallback doesn't get in the way of the approved item (q2h-2)
  const fallback = await tm.as('a1', ['propose', '-m', 'api v2, in case'])
  t.ok(/proposed P\d+.*asked ann/.test(fallback.stdout), fallback.stdout + fallback.stderr)
  const landed = await tm.as('a1', ['land', '-m', 'api v2', '--item', id])
  // the item carried it, and the fallback proposal is done with it
  t.ok(/landed P\d+ as #\d+/.test(landed.stdout), landed.stdout + landed.stderr)
  const fallbackId = fallback.stdout.match(/proposed (P\d+)/)[1]
  const props = await tm.as('a1', ['proposals'])
  t.absent(new RegExp(`${fallbackId} (open|approved)`).test(props.stdout), props.stdout)

  // split by default (TO-FIVE #14, #16): a land that is only partly protected lands the rest
  tm.write('a1', 'src/api/v3.js', '// v3\n')
  tm.write('a1', 'src/b.js', 'b\n')
  const split = await tm.as('a1', ['land', '-m', 'v3 and b'])
  t.ok(/split: \/src\/api\/v3\.js needs approval/.test(split.stdout), split.stdout + split.stderr)
  t.ok(/landed #\d+/.test(split.stdout), split.stdout + split.stderr)
  t.ok(/proposed P\d+ .*for \/src\/api\/v3\.js, asked ann/.test(split.stdout), split.stdout)
  t.is(tm.read('a1', 'src/api/v3.js'), '// v3\n', 'the protected file is back in the worktree')
  const pid = split.stdout.match(/proposed (P\d+)/)[1]
  const ok = await tm.as('ann', ['review', pid, 'approve'])
  t.is(ok.code, 0, ok.stdout + ok.stderr)
  const last = await tm.as('a1', ['land'])
  t.ok(new RegExp(`landed ${pid} as #\\d+`).test(last.stdout), last.stdout + last.stderr)

  // all protected, nothing approved: refused before --check runs the tests (#16)
  tm.write('a1', 'src/api/v9.js', '// v9\n')
  const early = await tm.as('a1', ['land', '-m', 'v9', '--check', 'echo RAN-THE-CHECK'])
  t.not(early.code, 0)
  t.absent(/RAN-THE-CHECK|checking main/.test(early.stdout), early.stdout)
  t.ok(/needs approval/.test(early.stdout + early.stderr), early.stdout + early.stderr)
  await tm.as('a1', ['restore', 'src/api/v9.js'])

  // --item with a split (#18): the item's paths land under it, the rest is proposed, and the
  // item stays open until that proposal lands with --item
  const made2 = await tm.as('a1', [
    'item',
    'new',
    'v4 endpoint',
    '--kind',
    'contract',
    '--paths',
    'src/api/v4.js'
  ])
  const id2 = made2.stdout.match(/item (C[0-9a-f]{6})/)[1]
  await tm.as('ann', ['review', id2, 'approve'])
  tm.write('a1', 'src/api/v4.js', '// v4\n')
  tm.write('a1', 'src/api/v5.js', '// v5\n')
  tm.write('a1', 'src/c.js', 'c\n')
  const mix = await tm.as('a1', ['land', '-m', 'v4 v5 c', '--item', id2])
  t.ok(/split: \/src\/api\/v5\.js needs approval/.test(mix.stdout), mix.stdout + mix.stderr)
  t.ok(/landed #\d+/.test(mix.stdout), mix.stdout + mix.stderr)
  t.absent(/completes/.test(mix.stdout), 'the item is not complete yet')
  t.ok(new RegExp(`once approved: hs land --item ${id2}`).test(mix.stdout), mix.stdout)
  const open2 = await tm.as('a1', ['claims'])
  t.ok(new RegExp(`${id2} "v4 endpoint"`).test(open2.stdout), open2.stdout)
  const pid2 = mix.stdout.match(/proposed (P\d+)/)[1]
  await tm.as('ann', ['review', pid2, 'approve'])
  const fin = await tm.as('a1', ['land', '--item', id2])
  t.ok(/landed (P\d+ as )?#\d+/.test(fin.stdout), fin.stdout + fin.stderr)
  t.ok(new RegExp(`completes ${id2}`).test(fin.stdout), fin.stdout)
})
