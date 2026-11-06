// hs blame (lib/blame.js): line attribution from path history, newest to oldest, stopping
// once every line asked about is attributed
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const c = require('compact-encoding')
const driveEntry = require('hyperdrive/lib/encoding')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const blame = require('../lib/blame')
const merge = require('../lib/merge')
const { run } = require('./helpers/team')

// states from plain versions, newest first: [seq, 'text' | null | undefined (unknown)]
function chain(versions, loads = []) {
  return versions.map(([seq, text], i) => {
    if (text === undefined) return { seq, origin: 'landed', unknown: true }
    return {
      seq,
      origin: seq === null ? 'worktree' : 'landed',
      load: () => {
        loads.push(i)
        if (text instanceof Error) throw text
        return text === null ? null : merge.textLines(b4a.from(text))
      }
    }
  })
}

const seqs = (res) => res.lines.map((l) => (l.boundary ? '^' : '') + l.seq)

test('blame: append, insert, edit, delete', async (t) => {
  const res = await blame(
    chain([
      [4, 'a\nB\nx\nc\nd\n'], // #4 edits b, #3's x stays
      [3, 'a\nb\nx\nc\nd\n'], // #3 inserts x, drops e
      [2, 'a\nb\nc\nd\ne\n'], // #2 appends d, e
      [1, 'a\nb\nc\n']
    ])
  )
  t.alike(seqs(res), ['1', '4', '3', '1', '2'])
  t.alike(
    res.lines.map((l) => l.text),
    ['a', 'B', 'x', 'c', 'd']
  )
  t.alike(
    res.lines.map((l) => l.line),
    [1, 2, 3, 4, 5]
  )
  t.is(res.boundary, null)
})

test('blame: deleted then recreated starts at the recreation', async (t) => {
  const res = await blame(
    chain([
      [5, 'a\nnew\n'],
      [4, 'a\n'],
      [3, null], // deleted
      [2, 'a\nold\n'],
      [1, 'a\n']
    ])
  )
  t.alike(seqs(res), ['4', '5'])
})

test('blame: stops early, never loading versions it does not need', async (t) => {
  const loads = []
  const res = await blame(
    chain(
      [
        [3, 'x\ny\n'],
        [2, 'p\nq\n'], // #3 rewrote everything
        [1, 'p\n']
      ],
      loads
    )
  )
  t.alike(seqs(res), ['3', '3'])
  t.alike(loads, [0, 1], '#1 never read')
})

test('blame: -L limits the lines and the walk', async (t) => {
  const loads = []
  const res = await blame(
    chain(
      [
        [3, 'a\nb\nC\n'],
        [2, 'a\nb\nc\n'],
        [1, 'a\n']
      ],
      loads
    ),
    { from: 3, to: 3 }
  )
  t.alike(seqs(res), ['3'])
  t.is(res.lines[0].line, 3)
  t.alike(loads, [0, 1])
})

test('blame: worktree lines are not landed', async (t) => {
  const res = await blame(
    chain([
      [null, 'a\nmine\nb\n'],
      [2, 'a\nb\n'],
      [1, 'a\n']
    ])
  )
  t.alike(seqs(res), ['1', 'null', '2'])
  t.is(res.lines[1].origin, 'worktree')
})

test('blame: one missing hist record is bridged, two make a boundary', async (t) => {
  // fromHistory: a record without values takes its content from the newer record's prev
  const e = (s) => b4a.from(s)
  const read = (entry) => merge.textLines(entry)
  const bridged = blame.fromHistory(
    [
      { seq: 3, prev: e('a\nb\n'), next: e('a\nb\nc\n') },
      { seq: 2, prev: undefined, next: undefined }, // content after #2 is #3's prev
      { seq: 1, prev: null, next: e('a\n') }
    ],
    read
  )
  t.absent(bridged[1].unknown)
  t.alike(seqs(await blame(bridged)), ['1', '2', '3'])

  const lost = blame.fromHistory(
    [
      { seq: 3, prev: undefined, next: e('a\nb\nc\n') },
      { seq: 2, prev: undefined, next: undefined },
      { seq: 1, prev: null, next: e('a\n') }
    ],
    read
  )
  t.ok(lost[1].unknown)
  const res = await blame(lost)
  t.alike(seqs(res), ['^3', '^3', '^3'])
  t.is(res.boundary.seq, 3)
})

test('blame: content no peer holds is a boundary, not a failure, when tolerated', async (t) => {
  const gone = new Error('block not available')
  gone.code = 'BLOCK_NOT_AVAILABLE'
  const versions = [
    [3, 'a\nb\nc\n'],
    [2, 'a\nb\n'],
    [1, gone]
  ]
  const res = await blame(chain(versions), { tolerate: (err) => err === gone })
  t.alike(seqs(res), ['^2', '^2', '3'])
  t.is(res.boundary.reason, 'content not held by any online peer')
  await t.exception(() => blame(chain(versions)), /block not available/, 'thrown otherwise')
})

test('blame: a file absent in the newest state is null', async (t) => {
  t.is(
    await blame(
      chain([
        [2, null],
        [1, 'a\n']
      ])
    ),
    null
  )
})

const put = (p, s) => ({ path: p, content: b4a.from(s) })

async function linesOf(repo, p, at) {
  const drive = repo.drive()
  try {
    const hist = await repo.pathHistory(p, { at })
    const states = blame.fromHistory(hist, async (entry) =>
      entry === null ? null : merge.textLines(await readBlob(drive, entry))
    )
    return await blame(states)
  } finally {
    await drive.close()
  }
}

async function readBlob(drive, value) {
  const entry = c.decode(driveEntry, value)
  if (!entry.blob) return b4a.alloc(0)
  const blobs = await drive.getBlobsFor(entry.blob)
  return blobs.get(entry.blob)
}

test('blame: on main, a rebased land is credited only with its own lines', async (t) => {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store)
  await repo.ready()
  t.teardown(async () => {
    await repo.close()
    await store.close()
  })

  const seed = await repo.workspace('seed')
  await seed.commit([put('/f.txt', 'one\ntwo\nthree\nfour\nfive\n')])
  t.is((await seed.land()).outcome.seq, 1)

  const a = await repo.workspace('a')
  const b = await repo.workspace('b')
  await a.commit([put('/f.txt', 'ONE\ntwo\nthree\nfour\nfive\n')])
  await b.commit([put('/f.txt', 'one\ntwo\nthree\nfour\nFIVE\n')])
  t.is((await a.land()).outcome.seq, 2)
  // b's land conflicts, rebases onto #2 (3-way merge) and lands as #3
  const res = await b.land({ rebase: 2 })
  t.is(res.outcome.status, 'accepted')
  t.is(res.outcome.seq, 3)

  const now = await linesOf(repo, '/f.txt')
  t.alike(
    now.lines.map((l) => l.text),
    ['ONE', 'two', 'three', 'four', 'FIVE']
  )
  t.alike(seqs(now), ['2', '1', '1', '1', '3'], '#3 is credited only with FIVE')

  const then = await linesOf(repo, '/f.txt', 2)
  t.alike(seqs(then), ['2', '1', '1', '1', '1'], 'as of #2')
})

test('blame: hs blame in a worktree, text and --json', { timeout: 120000 }, async (t) => {
  const dir = await tmp(t)
  const { env } = require('bare-process')
  const e = { ...env, HS_SURFACE: '', USER: 'me' }
  const write = (s) => fs.writeFileSync(path.join(dir, 'f.js'), s)
  t.is((await run(dir, ['init', '--as', 'me'], e)).code, 0)
  write('a\nb\n')
  t.is((await run(dir, ['land', '-m', 'first'], e)).code, 0)
  write('a\nB\nc\n')
  t.is((await run(dir, ['land', '-m', 'second'], e)).code, 0)
  write('a\nB\nmine\nc\n') // not landed

  const json = await run(dir, ['blame', 'f.js', '--json'], e)
  t.is(json.code, 0, json.stderr)
  const rows = json.stdout.trim().split('\n').map(JSON.parse)
  t.alike(
    rows.map((r) => [r.seq, r.landed, r.text]),
    [
      [1, true, 'a'],
      [2, true, 'B'],
      [null, false, 'mine'],
      [2, true, 'c']
    ]
  )
  t.is(rows[1].message, 'second')
  t.is(rows[1].author, 'me')

  const text = await run(dir, ['blame', '/f.js', '-L', '2,+2'], e)
  t.is(text.code, 0, text.stderr)
  const lines = text.stdout.trim().split('\n')
  t.is(lines.length, 2)
  t.ok(/^#2\s+me\s.*\s2\| B$/.test(lines[0]), lines[0])
  t.ok(/^-\s.*not landed\s+3\| mine$/.test(lines[1]), lines[1])

  const main = await run(dir, ['blame', 'f.js', '--main', '--json'], e)
  t.is(main.stdout.trim().split('\n').length, 3, '--main ignores the worktree')

  const old = await run(dir, ['blame', 'f.js', '--at', '1', '--json'], e)
  t.alike(
    old.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).text),
    ['a', 'b']
  )

  const missing = await run(dir, ['blame', 'nope.js'], e)
  t.is(missing.code, 1)
  t.ok(/no such file/.test(missing.stderr), missing.stderr)
})
