// `hs agents`: the agent instructions ship in the binary, current with docs/
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const tmp = require('test-tmp')
const { env } = require('bare-process')
const { run } = require('./helpers/team')

const ROOT = path.join(__dirname, '..')
const read = (f) => fs.readFileSync(path.join(ROOT, 'docs', f), 'utf8')

test('agents: the bundled instructions match docs/', (t) => {
  const docs = require('../lib/agents-doc')
  const stale = 'stale: run `node scripts/agents-doc.js`'
  t.is(docs.brief, read('BRIEF.md'), 'brief ' + stale)
  t.is(docs.full, read('AGENTS-min.md'), 'full playbook ' + stale)
  t.is(docs.plain, read('AGENTS-plain.md'), 'task-board playbook ' + stale)
})

test('agents: prints the brief, the full playbook, or writes AGENTS.md once', async (t) => {
  const dir = await tmp(t)
  const e = { ...env, HS_SURFACE: '' }
  const brief = await run(dir, ['agents'], e)
  t.is(brief.code, 0)
  t.is(brief.stdout, read('BRIEF.md'), 'hs agents prints the brief')
  t.is((await run(dir, ['agents', '--full'], e)).stdout, read('AGENTS-min.md'), '--full')
  t.is(
    (await run(dir, ['agents'], { ...e, HS_SURFACE: 'plain' })).stdout,
    read('AGENTS-plain.md'),
    'the task-board arm gets its own playbook'
  )
  const help = await run(dir, ['--help'], e)
  t.ok(/hs agents/.test(help.stdout + help.stderr), 'hs --help points agents at it')

  const wrote = await run(dir, ['agents', '--write'], e)
  t.is(wrote.code, 0, wrote.stderr)
  t.is(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), read('BRIEF.md'), 'AGENTS.md written')
  const again = await run(dir, ['agents', '--write'], e)
  t.is(again.code, 2, 'never over an existing file')
  t.ok(/already exists/.test(again.stderr), again.stderr)
})
