// Correctness fixes from experiment 4: restore drops committed edits, status shows leftover
// conflict markers, lands never have empty messages, proposals diff against their base, and
// an approval survives landing with --check onto unrelated teammates' work.
const test = require('brittle')
const { team } = require('./helpers/team')

test('fixes: restore, markers, messages, proposal diffs, approvals across rebases', async (t) => {
  const tm = await team(t, {
    files: { 'src/a.js': 'a\n', 'CONTRACTS.md': '# contracts\n', 'NOTES.md': '# notes\n' }
  })
  await tm.as('a1', ['sync'])
  await tm.as('a2', ['sync'])

  // restore: an edit that `commit` (or a rejected land) already put in the workspace
  tm.write('a1', 'src/a.js', 'edited\n')
  await tm.as('a1', ['commit'])
  const restored = await tm.as('a1', ['restore', 'src/a.js'])
  t.is(tm.read('a1', 'src/a.js'), 'a\n', 'restore brings back the version on main')
  t.ok(/dropped 1 committed, unlanded change/.test(restored.stdout), restored.stdout)
  const st = await tm.as('a1', ['status'])
  t.ok(st.stdout.includes('clean'), 'nothing left to land\n' + st.stdout)

  // status points at files that still carry conflict markers
  tm.write('a1', 'src/a.js', '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n')
  t.ok(/CONFLICT\s+\/src\/a.js/.test((await tm.as('a1', ['status'])).stdout))
  await tm.as('a1', ['restore', 'src/a.js'])

  // no -m: the land still says what it is
  tm.write('a1', 'src/b.js', 'b\n')
  t.is((await tm.as('a1', ['land'])).code, 0)
  t.ok(
    /update \/src\/b\.js/.test((await tm.as('a1', ['log', '-n', '1'])).stdout),
    'default message'
  )

  // a wait answered by something already on main says so; --new waits for new lands only
  const old = await tm.as('a2', ['watch', '--path', '/src/b.js', '--count', '1', '--timeout', '30'])
  t.is(old.code, 0)
  t.ok(/already on main before this wait/.test(old.stderr), old.stderr)
  const fresh = await tm.as('a2', [
    'watch',
    '--path',
    '/src/b.js',
    '--count',
    '1',
    '--new',
    '--timeout',
    '3'
  ])
  t.is(fresh.code, 2, '--new ignores what already landed')

  // a proposal, then a teammate's later land on the same file: the review diff shows only
  // the proposal's own change, not the teammate's lines as deletions
  tm.write('a2', 'CONTRACTS.md', '# contracts\nplan(day) -> Plan\n')
  const prop = await tm.as('a2', ['propose', '-m', 'pin Plan', '-r', 'a1'])
  t.is(prop.code, 0, prop.stderr)
  tm.write('a1', 'NOTES.md', '# notes\n- [a1] unrelated\n')
  t.is((await tm.as('a1', ['land', '-m', 'note'])).code, 0)
  const shown = await tm.as('a1', ['show', 'P1'])
  t.ok(shown.stdout.includes('+plan(day) -> Plan'), 'the proposal change')
  t.absent(/^-/m.test(shown.stdout.replace(/^--- .*$/m, '')), 'no phantom deletions')

  // approve, then the author lands with --check, which rebases onto a1's unrelated note
  // first: the approved files are untouched, so the approval still counts
  t.is((await tm.as('a1', ['review', 'P1', 'approve'])).code, 0)
  const landed = await tm.as('a2', ['land', '--check', 'true'])
  t.ok(/landed P1 as #\d+/.test(landed.stdout), landed.stdout + landed.stderr)
})
