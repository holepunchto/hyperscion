// The q0 experiment's arms (HS_SURFACE): which commands and flags agents get. pm and people
// run with the full surface; the arms only take things away.
const test = require('brittle')
const os = require('bare-os')
const { run } = require('./helpers/team')

const env = (surface) => ({ ...require('bare-process').env, HS_SURFACE: surface })
const commands = async (surface) => {
  const r = await run(os.cwd(), ['--help'], env(surface))
  // `hs --help` lists commands by group, each indented four spaces under its group
  return r.stdout
    .split('\n')
    .filter((l) => /^ {4}\S/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
}

test('surface: full, minimal and plain', async (t) => {
  const full = await commands('full')
  const minimal = await commands('minimal')
  const plain = await commands('plain')
  for (const c of ['claim', 'claims', 'item', 'propose', 'review', 'inbox', 'suggest']) {
    t.ok(full.includes(c), 'full has ' + c)
  }
  t.ok(minimal.includes('claim') && minimal.includes('claims'), 'minimal keeps claims')
  for (const c of ['item', 'propose', 'inbox', 'suggest', 'proposals']) {
    t.absent(minimal.includes(c), 'minimal drops ' + c)
  }
  t.ok(minimal.includes('review'), 'minimal keeps review (of a teammate land)')
  for (const c of ['claim', 'claims', 'item']) t.absent(plain.includes(c), 'plain drops ' + c)
  for (const c of ['land', 'sync', 'status', 'watch', 'log', 'show', 'cat']) {
    t.ok(plain.includes(c), 'every arm keeps ' + c)
  }

  const landHelp = await run(os.cwd(), ['land', '--help'], env('minimal'))
  t.absent(/--item/.test(landHelp.stdout), 'minimal hides land --item (lands link themselves)')
  const claimHelp = await run(os.cwd(), ['claim', '--help'], env('minimal'))
  t.ok(/--done/.test(claimHelp.stdout), 'minimal keeps claim --done')
  t.absent(
    /--with|--take|--note/.test(claimHelp.stdout.split('Flags:')[1] || ''),
    'minimal hides the advanced claim flags'
  )

  const hidden = await run(os.cwd(), ['propose'], env('minimal'))
  t.not(hidden.code, 0, 'a hidden command is unknown')
})
