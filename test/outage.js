// The hub going down (experiment 4, S3e): running feeds are peers that announce and hold
// every landed file, so teammates keep landing and syncing through each other; nobody is told
// "up to date" while unreachable; feeds say when they lose and regain peers.
const test = require('brittle')
const { team, waitFor } = require('./helpers/team')

const NO_TRACE = /^\s+at /m // a raw stack trace line

test('outage: feeds keep the team working while the hub is down', async (t) => {
  const tm = await team(t, {
    files: { 'src/a.js': 'a\n', 'NOTES.md': '# notes\n' },
    env: { HS_HUB_STALL_S: '4' }
  })

  const feed1 = tm.bgAs('a1', ['watch'])
  const feed2 = tm.bgAs('a2', ['watch'])
  await waitFor(() => /watching main/.test(feed1.output() + feed2.output().slice(0, 0)), 60_000)
  await waitFor(() => /watching main/.test(feed2.output()), 60_000)

  tm.write('a1', 'src/one.js', 'one\n')
  const first = await tm.as('a1', ['land', '-m', 'one'])
  t.is(first.code, 0, 'land with the hub up')
  await waitFor(() => /\bone\b/.test(feed2.output()), 30_000)

  await tm.stopHub()

  // a1 lands while the hub is down: a feed holds it
  tm.write('a1', 'src/two.js', 'two while the hub is down\n')
  const second = await tm.as('a1', ['land', '-m', 'two'])
  t.ok(/landed #\d+/.test(second.stdout), 'land while the hub is down: ' + second.stderr)
  t.absent(NO_TRACE.test(second.stdout + second.stderr), 'no stack trace')

  // a2 gets the content from a feed, not just the news
  const synced = await tm.as('a2', ['sync'])
  t.is(tm.read('a2', 'src/two.js'), 'two while the hub is down\n', 'a2 synced the content')
  t.absent(/no peers reachable/.test(synced.stderr), 'a2 reached a peer')
  await waitFor(() => /\btwo\b/.test(feed2.output()), 30_000)

  // the feeds still have each other, so what says "the hub is down" is lands not settling
  await waitFor(() => /hub not settling/.test(feed2.output()), 60_000)
  t.pass('feed says the hub is not settling')
  t.ok(/hub not settling/.test((await tm.as('a1', ['status'])).stderr), 'status says so too')
  await tm.startHub()
  await waitFor(() => /hub settling again/.test(feed2.output()), 60_000)
  t.pass('feed says the hub is back')
  // status reads this machine's main, which the feed may be ahead of: it catches up first
  await waitFor(() => /hub settling again/.test(feed1.output()), 60_000)
  const after = await tm.as('a1', ['status'])
  t.absent(/hub not settling/.test(after.stderr), 'status agrees with the feed: ' + after.stderr)
  t.ok(/last land: #\d+ final/.test(after.stdout), after.stdout)
  await tm.stopHub()

  const seq = Number(second.stdout.match(/landed #(\d+)/)[1])
  const shown = await tm.as('a2', ['show', String(seq)])
  t.is(shown.code, 0, 'show works during the outage')
  t.absent(NO_TRACE.test(shown.stdout + shown.stderr), 'show: no stack trace')

  // nobody reachable at all: sync says so instead of "up to date"
  await feed1.stop()
  await feed2.stop()
  const alone = await tm.as('a1', ['sync'])
  t.is(alone.code, 2, 'sync with nobody reachable exits 2')
  t.ok(/no peers reachable: showing local main #\d+/.test(alone.stderr), alone.stderr)
  t.absent(/up to date/.test(alone.stdout), 'never "up to date" when unreachable')
  const pushed = await tm.as('a1', ['push'])
  t.absent(
    NO_TRACE.test(pushed.stdout + pushed.stderr),
    'push: no stack trace\n' + pushed.stdout + pushed.stderr
  )

  // a lone feed says it has no peers, then that they are back
  const feed = tm.bgAs('a2', ['watch'])
  await waitFor(() => /no peers reachable/.test(feed.output()), 60_000)
  t.pass('a feed started with nobody around says so')
  await tm.startHub()
  await waitFor(() => /peers reachable again/.test(feed.output()), 60_000)
  const lost = feed.output().split('no peers reachable').length - 1
  await tm.stopHub()
  await waitFor(() => feed.output().split('no peers reachable').length - 1 > lost, 60_000).catch(
    (err) => {
      t.comment(feed.output())
      throw err
    }
  )
  t.pass('feed reports losing its peers')
  await tm.startHub()
  await waitFor(() => feed.output().split('peers reachable again').length > 2, 60_000)
  t.pass('feed reports peers back')
})

// S3e's failure: a3 lands and dies, the hub is down, and a3b (fresh, never synced) takes over.
// a3b must see a3's landed work through a teammate's feed instead of an empty main.
test('outage: a stand-in recovers landed work from a teammate while the hub is down', async (t) => {
  const tm = await team(t, {
    agents: ['a2', 'a3', 'a3b'],
    files: { 'src/a.js': 'a\n', 'NOTES.md': '# notes\n' }
  })
  const feed2 = tm.bgAs('a2', ['watch'])
  await waitFor(() => /watching main/.test(feed2.output()), 60_000)

  tm.write('a3', 'src/scheduler.js', 'plan v1\n')
  t.is((await tm.as('a3', ['land', '-m', 'scheduler v1'])).code, 0)
  await waitFor(() => /scheduler v1/.test(feed2.output()), 30_000)

  // a3's machine is gone and so is the hub; only a2's feed is up
  await tm.stopHub()
  const res = await tm.as('a3b', ['sync'])
  t.is(tm.read('a3b', 'src/scheduler.js'), 'plan v1\n', "a3b has a3's landed scheduler")
  t.absent(/no peers reachable/.test(res.stderr), res.stderr)
  t.ok(/scheduler v1/.test((await tm.as('a3b', ['log', '-n', '3'])).stdout), 'and its history')
})
