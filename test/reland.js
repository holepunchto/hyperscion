// TO-FIVE #1 (asked in seven runs): a land undone because a concurrent land on the same files
// came first (an outage) is landed again by itself, instead of waiting for its author to notice.
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { team } = require('./helpers/team')

test('an undone land is landed again by the next sync', async (t) => {
  t.timeout(240_000)
  const tm = await team(t, { agents: ['a1', 'a2'], files: { 'NOTES.md': '# notes\n' } })
  await tm.as('a1', ['sync'])
  await tm.as('a2', ['sync'])

  // both land the same file while nobody can order them
  await tm.stopHub()
  for (const a of ['a1', 'a2']) {
    fs.appendFileSync(path.join(tm.agents[a], 'NOTES.md'), `- [${a}] offline\n`)
    const r = await tm.as(a, ['land', '-m', `${a} offline`, '--offline'])
    t.ok(/landed #\d+/.test(r.stdout), r.stdout + r.stderr)
  }

  // they meet: one is ordered first and the other is undone
  await tm.startHub()
  await tm.as('a1', ['push'])
  await tm.as('a2', ['push'])
  const s1 = await tm.as('a1', ['sync'])
  const s2 = await tm.as('a2', ['sync'])
  const out = s1.stdout + s1.stderr + '\n' + s2.stdout + s2.stderr
  t.ok(/re-landed as #\d+/.test(out), out)

  // both lines are on main, for everyone
  await tm.as('a1', ['sync'])
  const notes = tm.read('a1', 'NOTES.md')
  t.ok(notes.includes('- [a1] offline') && notes.includes('- [a2] offline'), notes)
})
