// A hub server's restarts (lib/hubs.js): an applied update, or `hs hubs restart`, stops it at
// the next quiet moment (every repo settled, no land for a while) for its service to start
// again; without --restart-on-update an update only says so.
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const { HubHome, HubServer } = require('../lib/hubs')
const { run, waitFor, sleep } = require('./helpers/team')

const QUIET = 3000
// long next to a land (a whole `hs land` process): on a slow CI runner the second land took
// over 2 s to reach the hub and the 3 s window had closed (linux-arm64)
const QUIET_LANDS = 10_000

test('hubs restart: an update waits for a quiet moment', async (t) => {
  t.timeout(90_000)
  const { home, env, owner, land } = await setup(t)
  const server = new HubServer(home, {
    bootstrap: env.bootstrap,
    restartOnUpdate: true,
    quietMs: QUIET_LANDS
  })
  await server.start()
  t.teardown(() => server.stop(), { order: 0 })
  let exited = null
  server.exiting.then((why) => {
    exited = { ...why, at: Date.now() }
  })

  await land(owner, 'one', 'before the update')
  server.updateApplied()
  await sleep(1000)
  // a land in the quiet window pushes the restart back
  await land(owner, 'two', 'during the wait')
  t.absent(exited, 'not while lands are coming in')
  // the hub's own clock: when it saw main move, not when the lander's process returned
  const seen = server.lastActivity
  await waitFor(() => exited, 60_000)
  t.is(exited.reason, 'update')
  t.ok(
    exited.at - seen >= QUIET_LANDS,
    `waited ${exited.at - seen} ms after the hub saw the last land`
  )
})

test('hubs restart: without --restart-on-update an update only says so; hs hubs restart asks', async (t) => {
  const { home, env, owner, land, hs } = await setup(t)
  const server = new HubServer(home, { bootstrap: env.bootstrap, quietMs: QUIET })
  await server.start()
  t.teardown(() => server.stop(), { order: 0 })
  let exited = null
  server.exiting.then((why) => {
    exited = why
  })

  await land(owner, 'one', 'a land')
  server.updateApplied()
  await sleep(QUIET + 2000)
  t.absent(exited, 'no restart by itself')
  // the list reads status.json, which the server rewrites about once a second: poll it, and
  // show everything it printed if the notice never comes (CI: empty output under load)
  let listed = null
  await waitFor(async () => {
    listed = await hs(['hubs', 'list', '--home', home.dir])
    return /an update is applied: `hs hubs restart`/.test(listed.stdout)
  }, 30_000).catch(() => {})
  t.ok(
    /an update is applied: `hs hubs restart`/.test(listed.stdout),
    `stdout: ${listed.stdout} stderr: ${listed.stderr} exit ${listed.code}`
  )

  const asked = await hs(['hubs', 'restart', '--home', home.dir])
  t.is(asked.code, 0, asked.stderr)
  t.ok(asked.stdout.includes('start `hs hubs serve` again yourself'), 'no service: says so')
  await waitFor(() => exited, 30_000)
  t.is(exited.reason, 'asked')
})

async function setup(t) {
  const testnet = await createTestnet(3, t.teardown)
  const dir = await tmp(t)
  const home = new HubHome(path.join(dir, 'home'))
  const root = home.openStore()
  const { hub } = await home.createRepo(root, 'r1', { handle: 'owner' })
  await hub.close()
  await root.close()
  const envVars = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(','),
    USER: 'owner'
  }
  const owner = home.file('owners', 'r1')
  const hs = (args, cwd = dir) => run(cwd, args, envVars)
  const land = async (cwd, file, message) => {
    fs.writeFileSync(path.join(cwd, file + '.txt'), message + '\n')
    const res = await hs(['land', '-m', message], cwd)
    t.ok(/#\d+ final/.test(res.stdout), `${message}: final`)
    return Date.now()
  }
  return { home, env: { bootstrap: testnet.bootstrap }, owner, land, hs }
}
