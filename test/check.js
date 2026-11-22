// land --check on a busy main (q2-hs-2): a swarm landing under /swarm/ every second or so made
// every check re-run until --retries ran out. Main moving only in paths no check reads (marked
// `-check` in /.hsattributes) lands on the checked state; a teammate's change the check could
// see still re-runs it.
const test = require('brittle')
const fs = require('bare-fs')
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

// /.hschecks: the repo says what "verified" means. `hs check` runs it without landing, and
// every `hs land` runs its default line first (--skip-checks skips it)
test('repo-declared checks: hs check, and land runs the default', async (t) => {
  const tm = await team(t, {
    agents: ['a1'],
    files: {
      '.hschecks': [
        '# what hs check and hs land run',
        'lint                    run test ! -f src/BAD',
        'test                    run grep -q ok src/a.js',
        'docs   paths=/docs/     run echo docs-check',
        'slow   manual timeout=1 run sleep 30',
        // each waits (up to 10s) for the other to start: they pass only if they overlap
        'p1     manual parallel run touch ../p1.mark; for i in $(seq 100); do [ -f ../p2.mark ] && exit 0; sleep 0.1; done; exit 1',
        'p2     manual parallel run touch ../p2.mark; for i in $(seq 100); do [ -f ../p1.mark ] && exit 0; sleep 0.1; done; exit 1',
        'default lint test docs',
        ''
      ].join('\n'),
      'src/a.js': 'ok\n',
      'docs/guide.md': '# guide\n'
    }
  })
  await tm.as('a1', ['sync'])

  const list = await tm.as('a1', ['check', '--list'])
  t.is(list.code, 0, list.stderr)
  t.ok(/^slow\s+run sleep 30\s+\(manual timeout=1s\)$/m.test(list.stdout), list.stdout)
  t.ok(/^default: lint test docs$/m.test(list.stdout), list.stdout)

  // nothing changed: the whole default line runs
  const clean = await tm.as('a1', ['check'])
  t.is(clean.code, 0, clean.stdout + clean.stderr)
  t.ok(/checking main #\d+ \+ your changes: lint \(test ! -f src\/BAD\), test/.test(clean.stdout))
  t.ok(/check docs passed/.test(clean.stdout), clean.stdout)
  t.ok(/all 3 checks passed/.test(clean.stdout), clean.stdout)

  // a failure: every check still runs, and the failing one is named
  tm.write('a1', 'src/BAD', 'x\n')
  const bad = await tm.as('a1', ['check'])
  t.is(bad.code, 1, bad.stdout + bad.stderr)
  t.ok(/!! check lint failed \(exit 1/.test(bad.stderr), bad.stderr)
  t.ok(/check test passed/.test(bad.stdout), 'kept going: ' + bad.stdout)
  t.ok(/!! failed on main #\d+ \+ your changes: lint/.test(bad.stderr), bad.stderr)

  // land runs the default (docs left out: this change touches nothing under /docs/) and refuses
  const refused = await tm.as('a1', ['land', '-m', 'bad'])
  t.is(refused.code, 1, refused.stdout + refused.stderr)
  t.ok(/skipping docs: this change touches none of its paths=/.test(refused.stdout))
  t.ok(/!! not landed: check lint failed \(exit 1/.test(refused.stderr), refused.stderr)
  t.absent(/landed #/.test(refused.stdout))

  // fixed: land checks and lands
  fs.unlinkSync(path.join(tm.agents.a1, 'src/BAD'))
  tm.write('a1', 'src/b.js', 'b\n')
  const good = await tm.as('a1', ['land', '-m', 'b'])
  t.is(good.code, 0, good.stdout + good.stderr)
  t.ok(/check lint passed/.test(good.stdout) && /check test passed/.test(good.stdout))
  t.ok(/landed #\d+/.test(good.stdout), good.stdout)

  // a manual check runs when named; timeout= kills it
  tm.write('a1', 'src/c.js', 'c\n')
  const slow = await tm.as('a1', ['land', '-m', 'c', '--check', 'slow'])
  t.is(slow.code, 1, slow.stdout + slow.stderr)
  t.ok(/!! not landed: check slow failed \(timed out after/.test(slow.stderr), slow.stderr)

  // --skip-checks lands without them
  const skipped = await tm.as('a1', ['land', '-m', 'c', '--skip-checks'])
  t.is(skipped.code, 0, skipped.stderr)
  t.absent(/checking main #/.test(skipped.stdout), skipped.stdout)
  t.ok(/landed #\d+/.test(skipped.stdout))

  // a typo is not a command
  const typo = await tm.as('a1', ['check', 'lnit'])
  t.not(typo.code, 0)
  t.ok(
    /no check named lnit \(\/\.hschecks defines: lint, test, docs, slow, p1, p2\)/.test(
      typo.stderr
    ),
    typo.stderr
  )

  // a check that passed on exactly this tree isn't run again: hs check, then land, is one run
  tm.write('a1', 'src/d.js', 'd\n')
  const first = await tm.as('a1', ['check'])
  t.is(first.code, 0, first.stdout + first.stderr)
  t.ok(/check lint passed in/.test(first.stdout), first.stdout)
  const again = await tm.as('a1', ['check'])
  t.ok(/check lint passed on this tree \d+s ago \(not run again\)/.test(again.stdout), again.stdout)
  const forced = await tm.as('a1', ['check', '--recheck'])
  t.ok(/check lint passed in/.test(forced.stdout), '--recheck runs it: ' + forced.stdout)
  const landed = await tm.as('a1', ['land', '-m', 'd'])
  t.is(landed.code, 0, landed.stdout + landed.stderr)
  t.ok(/check test passed on this tree \d+s ago \(not run again\)/.test(landed.stdout))
  t.ok(/landed #\d+/.test(landed.stdout))

  // a change since the pass: run again
  tm.write('a1', 'src/d.js', 'd2\n')
  const changed = await tm.as('a1', ['check', 'lint'])
  t.ok(/check lint passed in/.test(changed.stdout), changed.stdout)

  // parallel checks next to each other run at the same time (each waits for the other to
  // start, so one at a time would fail both); output stays in order
  const par = await tm.as('a1', ['check', 'p1', 'p2'])
  t.is(par.code, 0, par.stdout + par.stderr)
  t.ok(/check p1 passed in[^\n]*\ncheck p2 passed in/.test(par.stdout), par.stdout)
})

// /.hsreview checks= rules: land runs what they require (even with --skip-checks), records the
// checks on the changeset, and hs log / hs show print them
test('checks required by /.hsreview are run, recorded and shown', async (t) => {
  const tm = await team(t, {
    agents: ['a1'],
    files: {
      '.hschecks': 'lint run true\nsec run echo sec-ran\ndefault lint\n',
      '.hsreview': '/src/ checks=sec\n',
      'src/a.js': 'a\n'
    }
  })
  await tm.as('a1', ['sync'])

  tm.write('a1', 'src/b.js', 'b\n')
  const checked = await tm.as('a1', ['check'])
  t.is(checked.code, 0, checked.stdout + checked.stderr)
  t.ok(/also running sec: \/\.hsreview requires it for \/src\/b\.js/.test(checked.stdout))
  t.ok(/check sec passed/.test(checked.stdout), checked.stdout)

  const landed = await tm.as('a1', ['land', '-m', 'b'])
  t.is(landed.code, 0, landed.stdout + landed.stderr)
  t.ok(
    /check sec passed on this tree/.test(landed.stdout),
    'cached from hs check: ' + landed.stdout
  )
  const seq = landed.stdout.match(/landed #(\d+)/)[1]

  const log = await tm.as('a1', ['log', '-n', '1'])
  t.ok(/^ {4}checked: lint,sec$/m.test(log.stdout), log.stdout)
  const show = await tm.as('a1', ['show', seq])
  t.ok(
    /checked before landing, on main #\d+ \+ these changes: lint \(passed earlier on this tree\), sec \(passed earlier on this tree\)/.test(
      show.stdout
    ),
    show.stdout
  )

  // --skip-checks skips the default, not what policy requires
  tm.write('a1', 'src/c.js', 'c\n')
  const skipped = await tm.as('a1', ['land', '-m', 'c', '--skip-checks'])
  t.is(skipped.code, 0, skipped.stdout + skipped.stderr)
  t.ok(/--skip-checks, but \/\.hsreview requires sec here: running them/.test(skipped.stdout))
  t.ok(/check sec passed in/.test(skipped.stdout))
  t.absent(/check lint/.test(skipped.stdout), 'the default is skipped')
  const one = await tm.as('a1', ['log', '-n', '1', '--oneline'])
  t.ok(/:: c|c {2}\(checked: sec\)/.test(one.stdout), one.stdout)

  // a required check /.hschecks doesn't define: refused before anything runs
  tm.write('a1', '.hsreview', '/src/ checks=sec\n/lib/ checks=missing\n')
  t.is((await tm.as('a1', ['land', '-m', 'policy', '--skip-checks'])).code, 0)
  tm.write('a1', 'lib/a.js', 'a\n')
  const refused = await tm.as('a1', ['land', '-m', 'lib'])
  t.not(refused.code, 0)
  t.ok(
    /\/lib\/a\.js needs check missing \(\/lib\/ in \/\.hsreview\), but \/\.hschecks doesn't define it/.test(
      refused.stderr
    ),
    refused.stderr
  )
})
