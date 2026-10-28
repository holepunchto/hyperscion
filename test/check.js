// land --check on a busy main (q2-hs-2): a swarm landing under /swarm/ every second or so made
// every check re-run until --retries ran out. Main moving only in paths no check reads (marked
// `-check` in /.hsattributes) lands on the checked state; a teammate's change the check could
// see still re-runs it.
const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { team, waitFor } = require('./helpers/team')

const BIN = path.join(__dirname, '..', 'bin.mjs')

test('land --check re-runs only when main moved where the check can see', async (t) => {
  const tm = await team(t, {
    files: {
      '.hsattributes': 'NOTES.md merge=union\n/swarm/ -check\n',
      'src/a.js': 'a\n',
      'NOTES.md': '# notes\n'
    }
  })
  await tm.as('a1', ['sync'])
  await tm.as('a2', ['sync'])

  // the check itself makes main move: a2 lands a file while a1's check runs (once)
  const a2lands = (file, marker) =>
    `if [ ! -f ${marker} ]; then touch ${marker}; cd '${tm.agents.a2}' && ` +
    `mkdir -p "$(dirname ${file})" && echo x > ${file} && ` +
    `USER=a2 '${os.execPath()}' '${BIN}' land -m 'a2 ${file}' >/dev/null 2>&1; fi`
  const markers = path.join(tm.dir, 'marker')

  // main moves only under /swarm/: one check, then land
  tm.write('a1', 'src/one.js', 'one\n')
  const quiet = await tm.as('a1', [
    'land',
    '-m',
    'one',
    '--check',
    a2lands('swarm/s1.txt', markers + '1')
  ])
  t.is(quiet.code, 0, quiet.stderr)
  t.is(quiet.stdout.split('checking main #').length - 1, 1, 'the check ran once\n' + quiet.stdout)
  t.ok(/outside what the check reads; landing on the checked state/.test(quiet.stdout))
  t.ok(/landed #\d+/.test(quiet.stdout), 'landed')

  // main moves in /src/: the check runs again, and says why
  tm.write('a1', 'src/two.js', 'two\n')
  const busy = await tm.as('a1', [
    'land',
    '-m',
    'two',
    '--check',
    a2lands('src/c.js', markers + '2')
  ])
  t.is(busy.code, 0, busy.stderr)
  t.is(busy.stdout.split('checking main #').length - 1, 2, 'the check ran again\n' + busy.stdout)
  t.ok(/while checking \(\/src\/c\.js #\d+ a2\); checking again/.test(busy.stdout), busy.stdout)
  t.ok(/landed #\d+/.test(busy.stdout), 'landed')

  // /.hsattributes is read from main as a string: union-merged files (NOTES.md) are not news
  // in "merged teammates' changes" (under Bare the attributes used to parse as empty)
  await tm.as('a2', ['sync'])
  tm.write('a2', 'NOTES.md', '# notes\n- a2 note\n')
  t.is((await tm.as('a2', ['land', '-m', 'a2 note'])).code, 0)
  tm.write('a1', 'NOTES.md', tm.read('a1', 'NOTES.md') + '- a1 note\n')
  const noted = await tm.as('a1', ['land', '-m', 'a1 note', '--check', 'true'])
  t.ok(/landed #\d+/.test(noted.stdout), noted.stdout + noted.stderr)
  t.absent(/merged teammates' changes into your edits: .*NOTES/.test(noted.stdout), noted.stdout)
  t.ok(tm.read('a1', 'NOTES.md').includes('- a2 note'), 'union merge kept both notes')
})

// q2 agents: `status`, `show` and `doctor` refused to run while their own land --check ran
// ("another hs process is using this worktree (e.g. hs seed running here)")
test('read-only commands work while a land holds the worktree', async (t) => {
  const tm = await team(t, { files: { 'src/a.js': 'a\n', 'NOTES.md': '# notes\n' } })
  await tm.as('a1', ['sync'])
  tm.write('a1', 'src/slow.js', 'slow\n')
  const landing = tm.bgAs('a1', ['land', '-m', 'slow', '--check', 'sleep 8'])
  await waitFor(() => /checking main #/.test(landing.output()), 60_000)

  const busy = /`hs land` \(pid \d+\) is using this worktree: showing local data, offline/
  const status = await tm.as('a1', ['status'])
  t.is(status.code, 0, status.stderr)
  t.ok(busy.test(status.stderr), status.stderr)
  t.ok(/workspace default/.test(status.stdout), status.stdout)

  for (const args of [
    ['log', '-n', '3'],
    ['show', '1', '--stat'],
    ['cat', '/src/a.js'],
    ['diff']
  ]) {
    const res = await tm.as('a1', args)
    t.is(res.code, 0, args.join(' ') + ': ' + res.stderr)
    t.ok(busy.test(res.stderr), args[0] + ' says why it is offline')
  }
  t.is((await tm.as('a1', ['cat', '/src/a.js'])).stdout, 'a\n', 'cat reads local main')

  // commands that write say who holds the worktree, not "hs seed running here"
  const sync = await tm.as('a1', ['sync'])
  t.not(sync.code, 0)
  t.ok(
    /`hs land` \(pid \d+, running \d+s\) is using this worktree; wait for it/.test(sync.stderr),
    sync.stderr
  )
  t.absent(/seed/.test(sync.stderr), 'no misleading seed hint')

  await waitFor(() => landing.exited(), 60_000)
  t.ok(/landed #\d+/.test(landing.output()), 'the land finished: ' + landing.output())
  const after = await tm.as('a1', ['status'])
  t.absent(/is using this worktree/.test(after.stderr), 'no banner once the land is done')
})

// q2s-hs-3: an agent waiting for its land to go final after an outage ran
// `land --wait-final` with nothing new; it printed "nothing to land" and didn't wait
test('land --wait-final with nothing to land waits for the last land', async (t) => {
  const tm = await team(t, { files: { 'src/a.js': 'a\n' } })
  await tm.as('a1', ['sync'])
  tm.write('a1', 'src/b.js', 'b\n')
  const landed = await tm.as('a1', ['land', '-m', 'b', '--no-wait'])
  const seq = landed.stdout.match(/landed #(\d+)/)[1]
  const res = await tm.as('a1', ['land', '--wait-final', '--timeout', '30'])
  t.is(res.code, 0, res.stderr)
  t.ok(/nothing to land/.test(res.stdout))
  t.ok(new RegExp(`waiting for your last land #${seq} to be final`).test(res.stdout), res.stdout)
  t.ok(new RegExp(`#${seq} final`).test(res.stdout), res.stdout)
})
