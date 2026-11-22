// Repo-declared checks (/.hschecks): what "verified" means is the project's call, not hs's.
//
//   # name   [options]        kind  command
//   lint                      run   npm run lint
//   test     timeout=10m      run   npm test
//   integ    manual           run   npm run test:integration
//   docs     paths=/docs/     run   npm run docs:check
//   default  lint test
//
// Options come before the kind, so the rest of the line is the command, verbatim (it may hold
// `#`, `=` and anything else the shell takes). Only lines starting with `#` are comments.
//   timeout=<n>[s|m|h]  kill the check after this long (default: none)
//   manual              run only when named, never as part of `default`
//   paths=<p>[,<p>]     run only when a change touches one of these (patterns as in
//                       /.hsattributes: no '/' matches the basename anywhere, '*' one segment,
//                       a trailing '/' everything under that directory)
// `default` names what `hs check` and `hs land` run. With a default, every `hs land` runs it
// (--skip-checks skips it); without one, land checks only when asked (--check).
// The `act <workflow>#<job>` kind is reserved for running CI workflow jobs locally (hermetic
// runs, check peers); it parses but doesn't run yet.
const os = require('bare-os')
const b4a = require('b4a')
const { spawn } = require('bare-subprocess')
const { patternToRegExp } = require('./merge')

const FILE = '/.hschecks'
const KINDS = ['run', 'act']
const NAME = /^[A-Za-z0-9][\w.-]*$/

function parseChecks(text) {
  const entries = new Map()
  const errors = []
  let defaults = null
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const at = `${FILE} line ${i + 1}`
    const words = line.split(/\s+/)
    const name = words[0]
    if (name === 'default') {
      defaults = words.slice(1)
      continue
    }
    if (!NAME.test(name)) {
      errors.push(`${at}: "${name}" isn't a check name (letters, digits, . _ -)`)
      continue
    }
    // options up to the kind; the rest of the line (as written) is the command
    const entry = {
      name,
      kind: null,
      command: '',
      timeout: 0,
      manual: false,
      paths: null,
      line: i + 1
    }
    let rest = line.slice(name.length)
    let bad = null
    for (;;) {
      const m = rest.match(/^\s+(\S+)/)
      if (!m) break
      const word = m[1]
      rest = rest.slice(m[0].length)
      if (KINDS.includes(word)) {
        entry.kind = word
        break
      }
      if (word === 'manual') entry.manual = true
      else if (word.startsWith('timeout=')) {
        entry.timeout = parseDuration(word.slice(8))
        if (!entry.timeout) bad = `bad timeout "${word.slice(8)}" (e.g. 90s, 10m, 1h)`
      } else if (word.startsWith('paths=')) {
        entry.paths = word.slice(6).split(',').filter(Boolean)
        if (!entry.paths.length) bad = 'paths= needs at least one pattern'
      } else {
        bad = `expected an option (timeout=, manual, paths=) or a kind (run, act), got "${word}"`
      }
      if (bad) break
    }
    if (!bad && !entry.kind) bad = 'missing the kind and command (e.g. `run npm test`)'
    entry.command = rest.trim()
    if (!bad && !entry.command) bad = `"${entry.kind}" needs a command`
    if (bad) {
      errors.push(`${at}: ${bad}`)
      continue
    }
    if (entries.has(name)) errors.push(`${at}: "${name}" is defined twice; the later one wins`)
    entries.set(name, entry)
  }
  if (defaults) {
    const known = []
    for (const n of defaults) {
      if (entries.has(n)) known.push(n)
      else errors.push(`${FILE}: default names "${n}", which isn't defined`)
    }
    defaults = known
  }
  return { entries, defaults, errors }
}

// 90 / 90s / 10m / 1h -> ms (0 if unreadable)
function parseDuration(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)(s|m|h)?$/)
  if (!m) return 0
  return Math.round(Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2] || 's'])
}

// What to run, as a list of { name, command, timeout, ... }, or null for nothing.
//   value undefined: the repo's default (null without one)
//   value naming checks ("lint" or "lint,test"): those, manual ones included
//   anything else: a shell command, as `land --check "<cmd>"` always took
function resolve(checks, value) {
  if (value === undefined || value === null || value === true) {
    if (!checks.defaults || !checks.defaults.length) return null
    return checks.defaults.map((n) => checks.entries.get(n)).filter((e) => !e.manual)
  }
  const names = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (names.length && names.every((n) => checks.entries.has(n))) {
    return names.map((n) => checks.entries.get(n))
  }
  return [
    { name: null, kind: 'run', command: String(value), timeout: 0, manual: false, paths: null }
  ]
}

// `hs check [words…]`: { list } or { error }. Names of checks run those; one argument that
// isn't a name runs as a command when it looks like one (has a space, or the repo declares no
// checks), so `hs check "npm test"` works and `hs check lnit` is a typo, not a command.
function pick(checks, words) {
  if (!words.length) {
    const list = resolve(checks, undefined)
    if (list && list.length) return { list }
    return {
      error: checks.entries.size
        ? `${FILE} has no \`default\` line: name the checks to run (${[...checks.entries.keys()].join(', ')})`
        : `this repo declares no checks (${FILE}); run a command with \`hs check "npm test"\`, or add ${FILE} (\`hs help check\`)`
    }
  }
  const unknown = words.filter((w) => !checks.entries.has(w))
  if (!unknown.length) return { list: words.map((w) => checks.entries.get(w)) }
  if (words.length === 1 && (/\s/.test(words[0]) || !checks.entries.size)) {
    return { list: resolve(checks, words[0]) }
  }
  const known = [...checks.entries.keys()]
  return {
    error:
      `no check named ${unknown.join(', ')}` +
      (known.length ? ` (${FILE} defines: ${known.join(', ')})` : '') +
      '; quote a command to run it as one: hs check "npm test"'
  }
}

// the checks a change to these paths should run: entries with paths= that the change doesn't
// touch are dropped (changed = null: no filter, e.g. `hs check` on an unchanged tree)
function forChanges(list, changed) {
  if (!changed) return { run: list, skipped: [] }
  const run = []
  const skipped = []
  for (const e of list) {
    if (!e.paths || changed.some((p) => e.paths.some((pat) => pathMatches(pat, p)))) run.push(e)
    else skipped.push(e)
  }
  return { run, skipped }
}

function pathMatches(pattern, path) {
  const subject = pattern.includes('/')
    ? path.replace(/^\//, '')
    : path.slice(path.lastIndexOf('/') + 1)
  return patternToRegExp(pattern).test(subject)
}

// "lint" / "npm test": how a check is named in output
function label(e) {
  return e.name || e.command
}

// Run one check in cwd: { code, output, secs, timedOut }. A command that can't start (e.g.
// /bin/sh missing) reports code 127, like the shell does for a missing command.
function runCheck(e, cwd) {
  if (e.kind !== 'run') {
    return Promise.resolve({
      code: 2,
      output: `${label(e)}: "${e.kind}" checks aren't supported yet (${FILE} reserves them)\n`,
      secs: '0.0',
      timedOut: false
    })
  }
  return runShell(e.command, cwd, e.timeout)
}

// With a timeout the check runs in its own process group, so the kill reaches what the shell
// started (npm, the test runner), not just the shell. Only then: a group of its own no longer
// gets the terminal's Ctrl-C.
function runShell(command, cwd, timeout = 0) {
  const started = Date.now()
  const win = os.platform() === 'win32'
  const group = !!timeout && !win
  return new Promise((resolve) => {
    let proc
    try {
      proc = win
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd })
        : spawn('/bin/sh', ['-c', command], { cwd, detached: group })
    } catch (err) {
      resolve({ code: 127, output: String(err.message) + '\n', secs: '0.0', timedOut: false })
      return
    }
    const chunks = []
    let timedOut = false
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true
          try {
            if (group) os.kill(-proc.pid, os.constants.signals.SIGTERM)
            else proc.kill()
          } catch {}
        }, timeout)
      : null
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => chunks.push(d))
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: timedOut ? 124 : code,
        output: b4a.toString(b4a.concat(chunks)),
        secs: ((Date.now() - started) / 1000).toFixed(1),
        timedOut
      })
    })
  })
}

const TAIL = 12
// lines in a test run's output that usually say what failed
const FAILURE = /not ok|✖|✗|\bfail(ed|ing|ure)?\b|Error\b|expected|actual|assert/i
const NOISE = /^\s+at |<Buffer |^\s*\|?\s*$/

// TO-FIVE #25 (q2h-7: a raw stack trace, no hint which change broke it): the lines that say
// what failed, and a short tail without stack frames (not repeating those lines)
function summarize(output) {
  const lines = String(output || '')
    .trimEnd()
    .split('\n')
  const key = lines.filter((l) => !NOISE.test(l) && FAILURE.test(l)).slice(0, 8)
  const tail = lines
    .filter((l) => !NOISE.test(l))
    .slice(-TAIL)
    .filter((l) => !key.includes(l))
  return { key: key.map((l) => l.trim()), tail }
}

module.exports = {
  FILE,
  parseChecks,
  parseDuration,
  resolve,
  pick,
  forChanges,
  label,
  runCheck,
  runShell,
  summarize
}
