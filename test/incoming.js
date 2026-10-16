// `sync` and `land` list what came in from teammates. In q2 a swarm's lands under /swarm/
// filled the list and folded a teammate's changeset into "... and 220 later". Now the
// busiest directories fold into a summary line instead, so teammates' work stays listed.
const test = require('brittle')
const { team, waitFor } = require('./helpers/team')

test('incoming: a busy directory folds into one line, teammates stay listed', async (t) => {
  t.timeout(240_000)
  const tm = await team(t, {
    agents: ['a1', 'a2', 'a3'],
    files: { 'src/a.js': 'a\n', 'NOTES.md': '# notes\n' }
  })
  for (const a of ['a1', 'a2', 'a3']) await tm.as(a, ['sync'])

  // a2 is a busy bot: 30 lands under /swarm/, landed offline and pushed
  for (let i = 0; i < 30; i++) {
    tm.write('a2', `swarm/s${i}.txt`, `${i}\n`)
    const res = await tm.as('a2', ['land', '-m', 'swarm ' + i, '--offline'])
    t.ok(/landed #\d+/.test(res.stdout), res.stdout + res.stderr)
    if (i === 27) {
      // a3's teammate change lands in the middle of it
      await tm.as('a2', ['push'])
      await tm.as('a3', ['sync'])
      tm.write('a3', 'src/b.js', 'b\n')
      t.is((await tm.as('a3', ['land', '-m', 'teammate b'])).code, 0)
      await tm.as('a2', ['sync'])
    }
  }
  const pushed = await tm.as('a2', ['push'])
  t.is(pushed.code, 0, 'push: ' + pushed.stdout + pushed.stderr)
  // wait until the hub serves all of it (a1 sees main at #32: skeleton + 30 swarm + a3)
  await waitFor(async () => {
    await tm.as('a1', ['fetch'])
    return /^#32 /m.test((await tm.as('a1', ['log', '-n', '1'])).stdout)
  }, 120_000)

  const synced = await tm.as('a1', ['sync'])
  t.is(synced.code, 0, synced.stderr)
  t.ok(/incoming from teammates \(31\)/.test(synced.stdout), synced.stdout)
  t.ok(/#\d+ a3 \/src\/b\.js :: teammate b/.test(synced.stdout), 'the teammate is listed')
  t.ok(/\/swarm\/: 30 changeset\(s\) by 1 writer\(s\)/.test(synced.stdout), 'swarm folded')
  t.absent(/#\d+ a2 \/swarm\//.test(synced.stdout), 'no swarm lines listed one by one')
  t.absent(/and \d+ later/.test(synced.stdout), 'nothing hidden')
})
