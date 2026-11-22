// /.hschecks: the repo says what "verified" means (lib/checks.js). Parsing, picking what to run,
// paths= filtering and the failure summary; land and `hs check` end to end are in test/check.js
const test = require('brittle')
const os = require('bare-os')
const checks = require('../lib/checks')

const FILE = [
  '# what hs check and hs land run',
  'lint                      run npm run lint',
  'test     timeout=10m      run npm test -- --reporter=tap # not a comment: part of the command',
  'integ    manual           run npm run test:integration',
  'docs     paths=/docs/,*.md run node scripts/docs.js',
  'default  lint test docs',
  ''
].join('\n')

test('checks: parse names, options, kind and the command as written', (t) => {
  const c = checks.parseChecks(FILE)
  t.alike(c.errors, [])
  t.alike([...c.entries.keys()], ['lint', 'test', 'integ', 'docs'])
  t.alike(c.defaults, ['lint', 'test', 'docs'])
  const test = c.entries.get('test')
  t.is(test.kind, 'run')
  t.is(test.command, 'npm test -- --reporter=tap # not a comment: part of the command')
  t.is(test.timeout, 600000)
  t.ok(c.entries.get('integ').manual)
  t.alike(c.entries.get('docs').paths, ['/docs/', '*.md'])
  t.is(c.entries.get('lint').command, 'npm run lint')
})

test('checks: mistakes are reported by line and the rest still parses', (t) => {
  const c = checks.parseChecks(
    [
      'ok run true',
      'nokind',
      'bad timeout=soon run x',
      'odd frobnicate run x',
      '$weird run x',
      'empty run',
      'ok run false',
      'default ok missing'
    ].join('\n')
  )
  t.is(c.entries.get('ok').command, 'false', 'the later definition wins')
  t.alike(c.defaults, ['ok'], 'unknown names leave the default')
  const text = c.errors.join('\n')
  t.ok(/line 2: missing the kind/.test(text), text)
  t.ok(/line 3: bad timeout "soon"/.test(text), text)
  t.ok(/line 4: expected an option .* got "frobnicate"/.test(text), text)
  t.ok(/line 5: "\$weird" isn't a check name/.test(text), text)
  t.ok(/line 6: "run" needs a command/.test(text), text)
  t.ok(/line 7: "ok" is defined twice/.test(text), text)
  t.ok(/default names "missing"/.test(text), text)
})

test('checks: the act kind is reserved: it parses but does not run', async (t) => {
  const c = checks.parseChecks('ci act ci.yaml#lint\n')
  t.alike(c.errors, [])
  const res = await checks.runCheck(c.entries.get('ci'), os.cwd())
  t.is(res.code, 2)
  t.ok(/"act" checks aren't supported yet/.test(res.output))
})

test('checks: durations', (t) => {
  t.is(checks.parseDuration('90'), 90000)
  t.is(checks.parseDuration('90s'), 90000)
  t.is(checks.parseDuration('1.5m'), 90000)
  t.is(checks.parseDuration('1h'), 3600000)
  t.is(checks.parseDuration('soon'), 0)
})

test('checks: resolve (land --check) takes names, a list of names, or a command', (t) => {
  const c = checks.parseChecks(FILE)
  t.alike(
    checks.resolve(c, undefined).map((e) => e.name),
    ['lint', 'test', 'docs'],
    'no value: the default'
  )
  t.alike(
    checks.resolve(c, 'integ').map((e) => e.name),
    ['integ'],
    'manual runs when named'
  )
  t.alike(
    checks.resolve(c, 'lint, test').map((e) => e.name),
    ['lint', 'test']
  )
  const cmd = checks.resolve(c, 'npm test')
  t.is(cmd.length, 1)
  t.is(cmd[0].name, null)
  t.is(cmd[0].command, 'npm test')
  t.is(checks.resolve(checks.parseChecks(''), undefined), null, 'no file: nothing by default')
})

test('checks: a manual check named in default is still left out of it', (t) => {
  const c = checks.parseChecks('a run true\nb manual run true\ndefault a b\n')
  t.alike(
    checks.resolve(c, undefined).map((e) => e.name),
    ['a']
  )
})

test('checks: pick (hs check words) tells a typo from a command', (t) => {
  const c = checks.parseChecks(FILE)
  t.alike(
    checks.pick(c, []).list.map((e) => e.name),
    ['lint', 'test', 'docs']
  )
  t.alike(
    checks.pick(c, ['test', 'integ']).list.map((e) => e.name),
    ['test', 'integ']
  )
  t.is(checks.pick(c, ['npm test']).list[0].command, 'npm test', 'quoted command')
  t.ok(
    /no check named lnit \(\/\.hschecks defines: lint, test/.test(checks.pick(c, ['lnit']).error)
  )
  t.ok(/quote a command/.test(checks.pick(c, ['npm', 'test']).error), 'unquoted command')

  const none = checks.parseChecks('')
  t.is(checks.pick(none, ['make']).list[0].command, 'make', 'no checks declared: a word runs')
  t.ok(/declares no checks/.test(checks.pick(none, []).error))
  const noDefault = checks.parseChecks('a run true\n')
  t.ok(/has no `default` line: name the checks to run \(a\)/.test(checks.pick(noDefault, []).error))
})

test('checks: paths= leaves out checks a change does not touch', (t) => {
  const c = checks.parseChecks(FILE)
  const list = checks.resolve(c, undefined)
  const names = (r) => r.map((e) => e.name)
  let r = checks.forChanges(list, ['/src/a.js'])
  t.alike(names(r.run), ['lint', 'test'])
  t.alike(names(r.skipped), ['docs'])
  r = checks.forChanges(list, ['/docs/guide/intro.txt'])
  t.alike(names(r.run), ['lint', 'test', 'docs'], '/docs/ matches everything under it')
  r = checks.forChanges(list, ['/lib/README.md'])
  t.alike(names(r.run), ['lint', 'test', 'docs'], '*.md matches the basename anywhere')
  r = checks.forChanges(list, null)
  t.alike(names(r.run), ['lint', 'test', 'docs'], 'no filter')
})

test('checks: summarize picks the failing lines and a tail without stack frames', (t) => {
  const output = [
    'TAP version 13',
    '# pricing',
    'ok 1 - adds',
    'not ok 2 - rounds',
    '  expected: 3',
    '  actual: 2',
    '    at Object.<anonymous> (/src/pricing.js:4:1)',
    '',
    '# tests 2, fail 1'
  ].join('\n')
  const { key, tail } = checks.summarize(output)
  t.alike(key, ['not ok 2 - rounds', 'expected: 3', 'actual: 2', '# tests 2, fail 1'])
  t.ok(!tail.some((l) => /^\s+at /.test(l)), 'no stack frames')
  t.ok(!tail.includes('not ok 2 - rounds'), 'key lines are not repeated')
  t.ok(tail.includes('ok 1 - adds'))
})

test(
  'checks: runShell reports exit codes, output and timeouts',
  { skip: os.platform() === 'win32' },
  async (t) => {
    const ok = await checks.runShell('echo out; echo err >&2', os.cwd())
    t.is(ok.code, 0)
    t.ok(/out/.test(ok.output) && /err/.test(ok.output))
    const fail = await checks.runShell('exit 3', os.cwd())
    t.is(fail.code, 3)
    const started = Date.now()
    // the timeout kills the whole group: the backgrounded sleep too, so this returns at once
    const slow = await checks.runShell('sleep 20 & sleep 21', os.cwd(), 300)
    t.ok(slow.timedOut)
    t.is(slow.code, 124)
    t.ok(Date.now() - started < 5000, 'killed, not waited out')
  }
)
