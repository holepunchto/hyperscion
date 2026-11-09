// A writer that landed while it couldn't reach a hub home, then pulled after teammates landed:
// the home's passive store only attached the cores a peer opened, and an idle peer had no
// writer core open, so it never heard of the new lands ("main at #33" on a phone while the hub
// was at #37). lib/hubs.js WriterAttacher attaches the repo's writer cores to its peers.
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const { run, background, waitFor } = require('./helpers/team')

test('hubs: a writer that landed offline catches up with the lands made since', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const dir = await tmp(t)
  const home = path.join(dir, 'home')
  const env = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(','),
    HS_HUB_HOME: home
  }
  const hs = (cwd, args, user = 'me') => run(cwd, args, { ...env, USER: user })
  const made = await hs(dir, ['hubs', 'new', 'r1', '--as', 'me'])
  t.is(made.code, 0, made.stderr)
  const repos = JSON.parse(fs.readFileSync(path.join(home, 'hubs.json'), 'utf8')).repos
  const owner = path.join(home, 'owners', 'r1')

  let server = start()
  function start() {
    const p = background(dir, ['hubs', 'serve'], { ...env, USER: 'me' })
    t.teardown(() => p.stop(), { order: 1 })
    return p
  }
  await waitFor(() => server.output().includes('hubs serving 1 repo(s)'), 30_000)

  const phone = path.join(dir, 'phone')
  const cloned = await hs(
    dir,
    ['clone', repos.r1.key, phone, '--as', 'phone', '--admit', path.join(home, 'admit', 'r1')],
    'phone'
  )
  t.is(cloned.code, 0, cloned.stderr)
  await waitFor(async () => {
    await hs(phone, ['fetch'], 'phone')
    return (await hs(phone, ['info'], 'phone')).stdout.includes('(writable)')
  }, 30_000)

  const land = async (wt, who, file) => {
    fs.writeFileSync(path.join(wt, file), file + '\n')
    const r = await hs(wt, ['land', '-m', file], who)
    t.comment(`${who} land ${file}: ${r.stdout.trim()} ${r.stderr.trim()}`)
    return r
  }
  await land(owner, 'me', 'o1.txt')
  await land(phone, 'phone', 'p1.txt')
  await land(owner, 'me', 'o2.txt')
  const synced = await hs(phone, ['pull'], 'phone')
  t.comment('phone pull before outage: ' + synced.stdout.trim())

  // the phone can't reach the hub: it lands twice, provisional
  await server.stop()
  await land(phone, 'phone', 'p2.txt')
  await land(phone, 'phone', 'p3.txt')

  server = start()
  await waitFor(() => server.output().includes('hubs serving 1 repo(s)'), 30_000)
  for (const f of ['o3.txt', 'o4.txt', 'o5.txt']) await land(owner, 'me', f)
  const ownerMain = (await hs(owner, ['status'])).stdout
  t.comment('owner status: ' + ownerMain)

  const pulled = await hs(phone, ['pull'], 'phone')
  t.comment('phone pull: ' + pulled.stdout.trim() + ' ' + pulled.stderr.trim())
  const status = await hs(phone, ['status'], 'phone')
  t.comment('phone status: ' + status.stdout)
  const ahead = pulled.stdout.match(/main #\d+ -> #(\d+)/)
  t.ok(ahead && Number(ahead[1]) >= 7, 'the phone pulled the owner lands: ' + pulled.stdout)
  await hs(phone, ['sync'], 'phone')
  t.ok(fs.existsSync(path.join(phone, 'o5.txt')), 'the phone has the owner lands after sync')
  t.comment(server.output())
})
