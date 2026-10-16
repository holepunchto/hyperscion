// The hub is down and a swarm keeps landing (q2-hs-3): a teammate's land must reach a running
// feed within seconds, so it stays readable after its author's `hs land` exits. In q2-hs-3 no
// feed took a2's land within the push timeout and its content stayed on a2's machine. Two
// causes: feeds closed their outage links during the first HS_HUB_STALL_S of the outage, and
// a feed mirrored changesets one at a time, oldest first, so a fresh land waited behind the
// swarm's backlog (~1 s each to fetch in an outage).
//   HS_OUTAGE_SWARM_WRITERS (20), HS_OUTAGE_SWARM_THINK (5 s), HS_OUTAGE_SWARM_DEBUG=1
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const z32 = require('z32')
const Context = require('../lib/context')
const { team, waitFor, sleep } = require('./helpers/team')

const WRITERS = Number(process.env.HS_OUTAGE_SWARM_WRITERS || 20)
const THINK_S = Number(process.env.HS_OUTAGE_SWARM_THINK || 5)

test('outage with a swarm: a teammate land reaches a feed in seconds', async (t) => {
  t.timeout(300_000)
  const tm = await team(t, { files: { 'src/a.js': 'a\n', 'NOTES.md': '# notes\n' } })
  const feed1 = tm.bgAs('a1', ['watch'])
  const feed2 = tm.bgAs('a2', ['watch'])
  await waitFor(() => /watching main/.test(feed1.output()), 60_000)
  await waitFor(() => /watching main/.test(feed2.output()), 60_000)

  const swarm = startSwarm(t, tm)
  await waitFor(() => swarm.lands() >= WRITERS, 120_000)
  t.pass(`swarm of ${WRITERS} landing every ~${THINK_S}s`)

  await tm.stopHub()
  await waitFor(
    () => /no peers reachable|peers reachable again/.test(feed1.output()),
    60_000
  ).catch(() => {})
  await sleep(5000) // let the outage mesh form and the swarm land a few more

  tm.write('a2', 'src/outage.js', 'landed while the hub is down\n')
  const started = Date.now()
  const landed = await tm.as('a2', ['land', '-m', 'outage land'])
  const landMs = Date.now() - started
  t.ok(/landed #\d+/.test(landed.stdout), landed.stdout + landed.stderr)
  const pushed = /pushed: a holder has the changes/.test(landed.stdout)
  t.comment(
    `a2 land took ${landMs} ms, pushed=${pushed}: ${landed.stdout
      .split('\n')
      .filter((l) => /push|holder/.test(l))
      .join(' | ')}`
  )

  // a2's land process is gone: the content must come from a feed now
  const readStart = Date.now()
  let read = null
  await waitFor(async () => {
    read = await tm.as('a1', ['sync'])
    return tm.read('a1', 'src/outage.js') === 'landed while the hub is down\n'
  }, 120_000).catch(() => {})
  const readMs = Date.now() - readStart
  const got = tm.read('a1', 'src/outage.js') !== null
  t.comment(
    `a1 had it after ${readMs} ms (${got}); last sync: ${
      read &&
      (read.stdout + read.stderr)
        .split('\n')
        .filter((l) => /fetch|stale|peers|synced/.test(l))
        .join(' | ')
    }`
  )
  if (process.env.HS_OUTAGE_SWARM_DEBUG) {
    if (process.env.HS_OUTAGE_SWARM_DUMP) {
      fs.writeFileSync(process.env.HS_OUTAGE_SWARM_DUMP + '.feed1', feed1.output())
      fs.writeFileSync(process.env.HS_OUTAGE_SWARM_DUMP + '.feed2', feed2.output())
    }
    t.comment('a2 land:\n' + landed.stdout + landed.stderr)
    t.comment(
      'feed1 tail:\n' +
        feed1
          .output()
          .split('\n')
          .filter((l) => !/sw-|\/swarm\//.test(l))
          .slice(-15)
          .join('\n')
    )
    t.comment(
      'feed2 tail:\n' +
        feed2
          .output()
          .split('\n')
          .filter((l) => !/sw-|\/swarm\//.test(l))
          .slice(-15)
          .join('\n')
    )
  }
  t.ok(pushed, 'a feed took the land before `hs land` exited')
  t.ok(landMs < 15_000, `the land is quick even with the hub down (${landMs} ms)`)
  t.ok(
    read && read.code === 0 && readMs < 15_000,
    `a teammate reads it within seconds (${readMs} ms)`
  )
  await swarm.stop()
})

function startSwarm(t, tm) {
  const { key } = Context.parseInvite(tm.invite)
  const bootstrap = tm.env.HS_BOOTSTRAP.split(',').map((hp) => {
    const [host, port] = hp.split(':')
    return { host, port: Number(port) }
  })
  const opts = {
    id: 'sw',
    count: WRITERS,
    mode: 'per-writer',
    dir: path.join(tm.dir, 'swarm'),
    key: b4a.toString(key, 'hex'),
    bootstrap,
    bootstrapWeight: 1,
    hot: [],
    hotP: 0,
    think: THINK_S,
    duration: 600,
    mesh: 'star',
    sharedDht: true
  }
  const proc = spawn(
    os.execPath(),
    [path.join(__dirname, '..', 'bench', 'swarm-worker.js'), JSON.stringify(opts)],
    {
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  let lands = 0
  let buf = ''
  let exited = false
  proc.on('exit', () => (exited = true))
  proc.stdout.on('data', (d) => {
    buf += b4a.toString(d)
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      let ev = null
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type === 'keys') {
        ev.keys.forEach((k, j) => {
          fs.writeFileSync(
            path.join(tm.dir, 'admit', `sw-${j}.key`),
            z32.encode(b4a.from(k, 'hex')) + '\n'
          )
        })
      } else if (ev.type === 'ready') {
        proc.stdin.write('go\n')
      } else if (ev.type === 'land' && ev.status === 'accepted') {
        lands++
      }
    }
  })
  const stop = async () => {
    if (exited) return
    proc.kill('SIGKILL')
    await waitFor(() => exited, 10_000).catch(() => {})
  }
  t.teardown(stop, { order: 0 })
  return { lands: () => lands, stop }
}
