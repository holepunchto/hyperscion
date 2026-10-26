// `hs hubs`: one hub process for many repos (lib/hubs.js). Driven through the real binary:
// repos made with `hubs new` (before and while serving), served by one `hubs serve`, used by
// unchanged agents: clone with --admit, land to final, sync through the hub, task signals
// through the hub, a feed that finds the hub again after a restart, and `hubs list`.
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const { run, background, waitFor, sleep } = require('./helpers/team')

test('hubs: one process hubs many repos', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const dir = await tmp(t)
  const home = path.join(dir, 'home')
  const env = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(','),
    HS_HUB_HOME: home
  }
  const hs = (cwd, args, user = 'me') => run(cwd, args, { ...env, USER: user })
  const config = () => JSON.parse(fs.readFileSync(path.join(home, 'hubs.json'), 'utf8'))

  // r1 made before anything serves the home
  const made = await hs(dir, ['hubs', 'new', 'r1', '--as', 'me'])
  t.is(made.code, 0, made.stderr)
  t.ok(made.stdout.includes('serve it:'), 'says how to serve it')
  t.is((await hs(dir, ['hubs', 'new', 'r1'])).code, 1, 'names are unique')
  t.is((await hs(dir, ['hubs', 'new', 'Bad Name'])).code, 1, 'names are checked')

  let server = startServer()
  function startServer() {
    const p = background(dir, ['hubs', 'serve'], { ...env, USER: 'me' })
    t.teardown(() => p.stop(), { order: 1 })
    return p
  }
  await waitFor(() => server.output().includes('hubs serving 1 repo(s)'), 30_000)
  const again = await hs(dir, ['hubs', 'serve'])
  t.is(again.code, 1, 'one server per home: ' + again.stderr.trim())

  // r2 made while serving: the server makes it and serves it at once
  const made2 = await hs(dir, ['hubs', 'new', 'r2', '--as', 'me'])
  t.is(made2.code, 0, made2.stderr)
  t.ok(server.output().includes('serving r2'), 'served without a restart')

  const repos = config().repos
  t.not(repos.r1.ns, repos.r2.ns, 'each repo in its own namespace of the store')

  // agents: a1 on both repos, a2 on r2
  const join = async (who, name) => {
    const wt = path.join(dir, who + '-' + name)
    const admit = path.join(home, 'admit', name)
    const cloned = await hs(dir, ['clone', repos[name].key, wt, '--as', who, '--admit', admit], who)
    t.is(cloned.code, 0, `${who} clones ${name}: ${cloned.stderr}`)
    await waitFor(async () => {
      await hs(wt, ['fetch'], who)
      return (await hs(wt, ['info'], who)).stdout.includes('(writable)')
    }, 30_000)
    return wt
  }
  const r1a1 = await join('a1', 'r1')
  const r2a1 = await join('a1', 'r2')
  const r2a2 = await join('a2', 'r2')

  for (const [wt, who, name] of [
    [r1a1, 'a1', 'r1'],
    [r2a1, 'a1', 'r2'],
    [r2a2, 'a2', 'r2']
  ]) {
    fs.writeFileSync(path.join(wt, who + '.txt'), `${who} on ${name}\n`)
    const landed = await hs(wt, ['land', '-m', `${who} on ${name}`], who)
    t.ok(/#\d+ final/.test(landed.stdout), `${who} lands on ${name}, final`)
  }
  // the owner worktree `hubs new` made is a working writer
  const owner = path.join(home, 'owners', 'r2')
  fs.writeFileSync(path.join(owner, 'owner.txt'), 'owner\n')
  const owned = await hs(owner, ['land', '-m', 'owner land'])
  t.ok(/#\d+ final/.test(owned.stdout), 'the owner lands, final: ' + owned.stderr)

  await hs(r2a2, ['sync'], 'a2')
  t.ok(fs.existsSync(path.join(r2a2, 'a1.txt')), 'a2 has a1 work on r2, through the hub')
  t.absent(fs.existsSync(path.join(r2a2, 'r1.txt')), 'repos stay apart')

  // a task signal reaches a teammate through the hub, with no land in between
  const task = await hs(r2a1, ['task', 'new', 'cache the matrix'], 'a1')
  const id = (task.stdout.match(/T[0-9a-z]+/) || [])[0]
  t.ok(id, 'task made')
  await hs(r2a2, ['sync'], 'a2')
  t.is((await hs(r2a1, ['task', 'start', id], 'a1')).code, 0)
  const board = await hs(r2a2, ['task'], 'a2')
  t.ok(/lead a1/.test(board.stdout), 'a2 sees a1 leading: ' + board.stdout)

  // hubs list, served and not
  await sleep(1500) // the server writes status.json every second
  const listed = JSON.parse((await hs(dir, ['hubs', 'list', '--json'])).stdout)
  t.ok(listed.served && listed.served.pid, 'list knows the server')
  const r2row = listed.repos.find((r) => r.name === 'r2')
  t.is(r2row.settled, r2row.seq, 'r2 settled through main')
  t.is(r2row.seq, 3, 'r2 main: a1, a2 and the owner')

  // a feed on r2, then a restart: the feed finds the hub again, lands settle again
  const feed = background(r2a2, ['watch', '--json'], { ...env, USER: 'a2' })
  t.teardown(() => feed.stop(), { order: 0 })
  await waitFor(() => connections() >= 1, 30_000).catch((err) => {
    t.comment(feed.output())
    throw err
  })
  await server.stop()
  const stopped = await hs(dir, ['hubs', 'list'])
  t.ok(stopped.stdout.includes('not served'), 'list after stop: ' + stopped.stdout)
  t.ok(/r2 +main #\d+, settled #\d+/.test(stopped.stdout), 'reads the store when not served')
  server = startServer()
  await waitFor(() => server.output().includes('hubs serving 2 repo(s)'), 30_000)
  await waitFor(() => connections() >= 1, 60_000)
  t.pass('the feed reconnected to the restarted hub')
  fs.writeFileSync(path.join(r2a1, 'after.txt'), 'after\n')
  const after = await hs(r2a1, ['land', '-m', 'after the restart'], 'a1')
  t.ok(/#\d+ final/.test(after.stdout), 'final after a restart')
  await waitFor(() => feed.output().includes('after the restart'), 30_000)
  t.pass('the feed got it')

  // nothing but the feed holds a connection to the hub while no command runs
  function connections() {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'status.json'), 'utf8')).connections
    } catch {
      return 0
    }
  }
})
