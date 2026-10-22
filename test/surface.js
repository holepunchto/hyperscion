// The q0 experiment's arms (HS_SURFACE): which commands and flags agents get. pm and people
// run with the full surface; the arms only take things away.
const test = require('brittle')
const os = require('bare-os')
const { run } = require('./helpers/team')

const env = (surface) => ({ ...require('bare-process').env, HS_SURFACE: surface })
const commands = async (surface) => {
  const r = await run(os.cwd(), ['--help'], env(surface))
  // `hs --help` lists commands by group, each indented four spaces under its group; a
  // subcommand by its full path ('task start')
  return r.stdout
    .split('\n')
    .filter((l) => /^ {4}\S/.test(l))
    .map((l) => l.trim().split(/\s{2,}/)[0])
}

test('surface: full, minimal and plain', async (t) => {
  const full = await commands('full')
  const minimal = await commands('minimal')
  const plain = await commands('plain')
  const tasks = ['list', 'new', 'split', 'start', 'stop', 'done', 'drop'].map((c) => 'task ' + c)
  for (const c of [...tasks, 'propose', 'review', 'inbox']) {
    t.ok(full.includes(c), 'full has ' + c)
  }
  for (const c of ['task list', 'task start', 'task stop', 'task done', 'review']) {
    t.ok(minimal.includes(c), 'minimal keeps ' + c)
  }
  for (const c of ['task new', 'task split', 'task drop', 'propose', 'inbox', 'proposals']) {
    t.absent(minimal.includes(c), 'minimal drops ' + c)
  }
  for (const c of tasks) t.absent(plain.includes(c), 'plain drops ' + c)
  for (const c of ['land', 'sync', 'status', 'watch', 'log', 'show', 'cat']) {
    t.ok(plain.includes(c), 'every arm keeps ' + c)
  }

  const landHelp = await run(os.cwd(), ['land', '--help'], env('minimal'))
  t.absent(/--task/.test(landHelp.stdout), 'minimal hides land --task (lands link themselves)')
  const startHelp = await run(os.cwd(), ['task', 'start', '--help'], env('minimal'))
  t.absent(
    /--with|--take|--note/.test(startHelp.stdout.split('Flags:')[1] || ''),
    'minimal hides the advanced start flags'
  )
  const plainTask = await run(os.cwd(), ['task'], env('plain'))
  t.not(plainTask.code, 0, 'plain has no tasks at all')

  const hidden = await run(os.cwd(), ['propose'], env('minimal'))
  t.not(hidden.code, 0, 'a hidden command is unknown')
})
