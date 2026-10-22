// Tier 0 of the experiment loop: scripted agent flows through the real CLI, no LLM. Every
// change to how agents coordinate (claims, splits, approvals, waits, re-lands) runs these
// before any LLM run: the losses in q2h-2 and q2-hs-7 were our own flow regressions that only
// a 7-25 minute LLM run caught. Each flow is scored with the LLM runs' own rules
// (scripts/experiment/metrics.js) and the numbers go to flows.json in the team directory.
//
// Not covered: the view-gap class (q2h-2) needs a real fast-forward under swarm load.
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { team, waitFor } = require('./helpers/team')
const metrics = require('../scripts/experiment/metrics')

const SKELETON = {
  'CONTRACTS.md':
    '# contracts\n\n## pricing (a1)\n\n## scheduler (a2)\n\n## report (a3)\n\n## end\n',
  'NOTES.md': '# notes\n',
  'src/pricing.js': '// pricing\n',
  'src/scheduler.js': '// scheduler\n',
  'src/report.js': '// report\n'
}

test('flows: claim, split, approve, merge, re-land and wait, scored', async (t) => {
  t.timeout(600_000)
  const tm = await team(t, { agents: ['a1', 'a2', 'a3', 'ann'], files: SKELETON })
  const trace = path.join(tm.dir, 'trace.jsonl')
  tm.env.HS_TRACE = trace
  const owner = path.join(tm.dir, 'owner')
  const ownerHs = (args) => tm.hs(owner, args, 'owner')

  // a person (ann) approves contract changes
  const annKey = (await tm.as('ann', ['info'])).stdout.match(/^writer\s+(\S+)/m)[1]
  await ownerHs(['add-writer', annKey, '--as', 'ann', '--human'])
  await ownerHs(['sync'])
  fs.writeFileSync(
    path.join(owner, '.hsreview'),
    '/CONTRACTS.md approvals=1 reviewers=@humans\ntask kind=contract approvals=1 reviewers=@humans\n'
  )
  await ownerHs(['land', '-m', 'policy'])
  for (const a of ['a1', 'a2', 'a3']) await tm.as(a, ['sync'])

  // one flow: run it, then score the calls it made with the LLM runs' rules
  const results = []
  const flow = async (name, fn) => {
    const from = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').length - 1 : 0
    const started = Date.now()
    await fn()
    const recs = fs
      .readFileSync(trace, 'utf8')
      .split('\n')
      .slice(from)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => /^a\d$/.test(r.agent))
    const c = metrics.coordinationMetrics(recs, started)
    const row = {
      flow: name,
      calls: recs.length,
      coordination_calls: c.coordination_calls,
      round_trips_per_land: c.round_trips_per_land,
      seconds: Math.round((Date.now() - started) / 1000)
    }
    results.push(row)
    t.comment(JSON.stringify(row))
    return row
  }

  // F1: three agents claim the change request at once; exactly one leads
  let id = null
  let lead = null
  await flow('F1 claim race', async () => {
    const made = await ownerHs([
      'task',
      'new',
      'CR-1: price per flight minute',
      '--paths',
      'src/pricing.js'
    ])
    id = made.stdout.match(/task (T[0-9a-f]{6})/)[1]
    const res = await Promise.all(['a1', 'a2', 'a3'].map((a) => tm.as(a, ['task', 'start', id])))
    const leads = res.filter((r) => /you lead/.test(r.stdout))
    t.is(leads.length, 1, res.map((r) => r.stdout).join('\n---\n'))
    lead = ['a1', 'a2', 'a3'][res.indexOf(leads[0])]
    // a loser with --if-free takes its claim back at once
    const loser = ['a1', 'a2', 'a3'].find((a) => a !== lead)
    const back = await tm.as(loser, ['task', 'start', id, '--if-free'])
    t.is(back.code, 2, back.stdout)
    t.ok(new RegExp(`withdrawn: ${lead} leads ${id}`).test(back.stdout), back.stdout)
  })
  const others = ['a1', 'a2', 'a3'].filter((a) => a !== lead)

  // F2: only the lead splits the item; a teammate can share it
  await flow('F2 parts', async () => {
    const part = await tm.as(lead, ['task', 'split', id, 'flight minutes per stop'])
    t.ok(/task T[0-9a-f]{6}/.test(part.stdout), part.stdout + part.stderr)
    const refused = await tm.as(others[0], ['task', 'split', id, 'my own piece'])
    t.not(refused.code, 0)
    t.ok(new RegExp(`${lead} leads ${id}`).test(refused.stderr), refused.stderr)
    const shared = await tm.as(others[1], ['task', 'start', id, '--with', lead])
    t.is(shared.code, 0, shared.stderr)
  })

  // F3: a land touching the protected contract lands the rest and proposes the contract
  let pid = null
  await flow('F3 auto-split', async () => {
    tm.write(lead, 'src/pricing.js', '// pricing per flight minute\n')
    const contracts = tm.read(lead, 'CONTRACTS.md')
    tm.write(
      lead,
      'CONTRACTS.md',
      contracts.replace('## pricing (a1)\n', '## pricing (a1)\nprice(trip) -> EUR\n')
    )
    const split = await tm.as(lead, ['land', '-m', 'pricing'])
    t.ok(/split: \/CONTRACTS\.md needs approval/.test(split.stdout), split.stdout + split.stderr)
    t.ok(/landed #\d+/.test(split.stdout), split.stdout)
    const m = split.stdout.match(/proposed (P\d+) for \/CONTRACTS\.md, asked ann/)
    t.ok(m, split.stdout)
    pid = m && m[1]
    // a teammate reviews the land itself: a review record, no NOTES.md land (q0b-min-2)
    const seq = split.stdout.match(/landed #(\d+)/)[1]
    await tm.as(others[0], ['sync'])
    const reviewed = await tm.as(others[0], ['review', '#' + seq, 'approve', '-m', 'looks right'])
    t.is(reviewed.code, 0, reviewed.stdout + reviewed.stderr)
  })

  // F4: the person approves from the inbox; the author lands the approved proposal
  await flow('F4 approve and land', async () => {
    const inbox = await tm.as('ann', ['inbox', '--json'])
    t.ok(inbox.stdout.includes(pid), inbox.stdout)
    const ok = await tm.as('ann', ['review', pid, 'approve'])
    t.is(ok.code, 0, ok.stdout + ok.stderr)
    const landed = await tm.as(lead, ['land'])
    t.ok(new RegExp(`landed ${pid} as #\\d+`).test(landed.stdout), landed.stdout + landed.stderr)
  })

  // F5: two sections of the same protected file, approved separately: the second keeps its
  // approval after the first merges in, and says why
  await flow('F5 section merge', async () => {
    const [x, y] = others
    for (const a of [x, y]) await tm.as(a, ['sync'])
    const section = { a2: '## scheduler (a2)\n', a3: '## report (a3)\n', a1: '## pricing (a1)\n' }
    for (const a of [x, y]) {
      const text = tm.read(a, 'CONTRACTS.md')
      tm.write(a, 'CONTRACTS.md', text.replace(section[a], section[a] + `${a}(day) -> Plan\n`))
    }
    const px = (await tm.as(x, ['propose', '-m', 'x'])).stdout.match(/proposed (P\d+)/)[1]
    const py = (await tm.as(y, ['propose', '-m', 'y'])).stdout.match(/proposed (P\d+)/)[1]
    await tm.as('ann', ['review', px, 'approve'])
    await tm.as('ann', ['review', py, 'approve'])
    const lx = await tm.as(x, ['land'])
    t.ok(new RegExp(`landed ${px} as #\\d+`).test(lx.stdout), lx.stdout + lx.stderr)
    const ly = await tm.as(y, ['land'])
    t.ok(new RegExp(`landed ${py} as #\\d+`).test(ly.stdout), ly.stdout + ly.stderr)
    t.ok(new RegExp(`approval of ${py} kept for /CONTRACTS.md`).test(ly.stdout), ly.stdout)
  })

  // F7: waits. A teammate change you already have doesn't end a wait (it's named when the wait
  // times out), your own land never counts, and --sync brings what arrives into your files
  await flow('F7 watch waits', async () => {
    const [x, y] = others
    await tm.as(y, ['sync'])
    const started = Date.now()
    const have = await tm.as(y, [
      'watch',
      '--path',
      'src/pricing.js',
      '--count',
      '1',
      '--timeout',
      '4'
    ])
    t.is(have.code, 2, have.stdout + have.stderr)
    t.ok(/already in your files: #\d+ \S+ \/src\/pricing\.js/.test(have.stderr), have.stderr)
    t.ok(Date.now() - started < 20_000, 'the wait ends at its timeout')

    tm.write(y, 'src/own.js', 'own\n')
    await tm.as(y, ['land', '-m', 'own'])
    const own = await tm.as(y, [
      'watch',
      '--path',
      'src/own.js',
      '--count',
      '1',
      '--new',
      '--timeout',
      '4'
    ])
    t.is(own.code, 2, 'my own land does not end my wait: ' + own.stdout)

    const waiting = tm.bgAs(y, [
      'watch',
      '--path',
      'src/x.js',
      '--count',
      '1',
      '--sync',
      '--timeout',
      '60'
    ])
    await new Promise((resolve) => setTimeout(resolve, 3000))
    tm.write(x, 'src/x.js', 'x\n')
    await tm.as(x, ['land', '-m', 'x'])
    await waitFor(() => waiting.exited(), 60_000)
    t.is(tm.read(y, 'src/x.js'), 'x\n', waiting.output())
  })

  // F6: lands made while nobody can order them: the one undone comes back with the next sync
  await flow('F6 outage re-land', async () => {
    const [x, y] = others
    for (const a of [x, y]) await tm.as(a, ['sync'])
    await tm.stopHub()
    for (const a of [x, y]) {
      fs.appendFileSync(path.join(tm.agents[a], 'NOTES.md'), `- [${a}] offline\n`)
      await tm.as(a, ['land', '-m', `${a} offline`, '--offline'])
    }
    await tm.startHub()
    for (const a of [x, y]) await tm.as(a, ['push'])
    const s1 = await tm.as(x, ['sync'])
    const s2 = await tm.as(y, ['sync'])
    const out = s1.stdout + s1.stderr + s2.stdout + s2.stderr
    t.ok(/re-landed as #\d+/.test(out), out)
  })

  // F9: a partition. Two agents claim the same item, and also put a claim line on a TASKS.md
  // board, while the hub is down and they never overlap: neither sees the other. When they
  // meet, the claim has one lead by the same rule on every peer; the board keeps both lines
  // and nothing says who holds it (the case q0bo's board agents worried about)
  await flow('F9 partition: claim vs board', async () => {
    const [x, y] = others
    for (const a of [x, y]) await tm.as(a, ['sync'])
    const made = await ownerHs(['task', 'new', 'CR-2: cache distances'])
    const id2 = made.stdout.match(/task (T[0-9a-f]{6})/)[1]
    for (const a of [x, y]) await tm.as(a, ['sync'])
    await tm.stopHub()
    for (const a of [x, y]) {
      // nobody heard it: the verdict says so instead of a bare "you lead" (q0bp)
      const alone = await tm.as(a, ['task', 'start', id2])
      t.is(alone.code, 2, alone.stdout)
      t.ok(/nobody heard you start it/.test(alone.stderr), alone.stderr)
      fs.appendFileSync(path.join(tm.agents[a], 'NOTES.md'), `- [${a}] taking CR-2\n`)
      await tm.as(a, ['land', '-m', `${a} takes CR-2`, '--offline'])
    }
    // a wait says the hub is out of reach instead of blocking in silence (q0bs)
    const waited = await tm.as(x, ['wait-final', '--timeout', '1'])
    t.ok(/hub is not reachable from here/.test(waited.stdout), waited.stdout + waited.stderr)
    await tm.startHub()
    // the land that lost the order is undone: push says so instead of timing out (q0bp)
    for (const a of [x, y]) {
      const pushed = await tm.as(a, ['push'])
      t.absent(/push timed out/.test(pushed.stdout), pushed.stdout + pushed.stderr)
    }
    for (const a of [x, y]) await tm.as(a, ['sync'])
    const verdicts = []
    for (const a of [x, y]) verdicts.push(await tm.as(a, ['task', 'start', id2]))
    const leads = verdicts.filter((v) => /you lead/.test(v.stdout))
    t.is(leads.length, 1, 'the claim converges: ' + verdicts.map((v) => v.stdout).join(' | '))
    t.alike(
      verdicts.map((v) => v.code).sort(),
      [0, 2],
      'one leads (0), the other knows it lost (2)'
    )
    // the lead closes it, so later flows start from a clean board
    const winner = [x, y][verdicts.indexOf(leads[0])]
    await tm.as(winner, ['task', 'done', id2])
    await tm.as(x, ['sync'])
    const board = tm.read(x, 'NOTES.md')
    t.ok(
      board.includes(`- [${x}] taking CR-2`) && board.includes(`- [${y}] taking CR-2`),
      'the board keeps both claims, with no rule for which holds'
    )
  })

  // F10: the lead's land closes the item it links itself to with --done
  await flow('F10 land --done', async () => {
    const [x] = others
    await tm.as(x, ['sync'])
    const made = await ownerHs(['task', 'new', 'CR-3: log every plan'])
    const id3 = made.stdout.match(/task (T[0-9a-f]{6})/)[1]
    await tm.as(x, ['sync'])
    const claimed = await tm.as(x, ['task', 'start', id3])
    t.ok(/you lead/.test(claimed.stdout), claimed.stdout)
    tm.write(x, 'src/log.js', '// log\n')
    const landed = await tm.as(x, ['land', '-m', 'log plans', '--done'])
    t.ok(new RegExp(`linked to ${id3}`).test(landed.stdout), landed.stdout + landed.stderr)
    t.ok(new RegExp(`completes ${id3}`).test(landed.stdout), landed.stdout)
  })

  // F11: a site split. x and y meet each other but not the hub or z; a claim on either side
  // is heard there, so each side has a lead until the sites meet. On heal the earlier claim
  // leads everywhere and the later side is told to stand down (q0bs)
  await flow('F11 site split: two leads, then one', async () => {
    const [x, y, z] = ['a1', 'a2', 'a3']
    const made = await ownerHs(['task', 'new', 'CR-4: cache flight minutes'])
    const id4 = made.stdout.match(/task (T[0-9a-f]{6})/)[1]
    for (const a of [x, y, z]) await tm.as(a, ['sync'])
    await tm.split([x, y])
    const feeds = [x, y].map((a) => tm.bgAs(a, ['watch', '--json']))
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const bx = await tm.as(x, ['task', 'start', id4])
    t.is(bx.code, 0, 'heard on site B: ' + bx.stdout + bx.stderr)
    t.absent(/nobody heard/.test(bx.stderr), 'a peer on its side heard it')
    const by = await tm.as(y, ['task', 'start', id4, '--if-free'])
    t.is(by.code, 2, 'site B agrees x leads: ' + by.stdout + by.stderr)
    const az = await tm.as(z, ['task', 'start', id4])
    t.ok(/you lead/.test(az.stdout), 'site A has its own lead: ' + az.stdout + az.stderr)
    tm.write(z, 'src/cache.js', '// z cache\n')
    await tm.as(z, ['land', '-m', 'z cache'])
    for (const f of feeds) await f.stop()
    tm.heal([x, y])
    let zs = null
    await waitFor(async () => {
      await tm.as(x, ['sync'])
      zs = await tm.as(z, ['sync'])
      return new RegExp(`${id4}.*${x} leads`).test(zs.stdout)
    }, 60_000).catch(() => {})
    t.ok(new RegExp(`${x} leads; you started it too, later`).test(zs.stdout), zs.stdout)
    const again = await tm.as(z, ['task', 'start', id4])
    t.is(again.code, 2, 'z knows it lost: ' + again.stdout + again.stderr)
    const xs = await tm.as(x, ['task'])
    t.ok(/lead a1/.test(xs.stdout), 'x leads on its side too: ' + xs.stdout)
    await tm.as(x, ['task', 'done', id4])
  })

  fs.writeFileSync(path.join(tm.dir, 'flows.json'), JSON.stringify(results, null, 2) + '\n')
  // loose ceilings: a flow that suddenly needs many more calls is a regression to look at
  for (const r of results) t.ok(r.calls <= 30, `${r.flow}: ${r.calls} calls`)
})
