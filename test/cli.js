// End-to-end through the real `hs` binary on a private DHT testnet: a hub holder admitting two
// agents, then the agent-facing messages and watch behaviours from experiment 2's feedback.
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { spawn } = require('bare-subprocess')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')

const BIN = path.join(__dirname, '..', 'bin.mjs')

test('cli: rebase messages, incoming summaries, watch waits, timeouts, stop and resume', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const env = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(',')
  }
  const dir = await tmp(t)
  const hub = path.join(dir, 'hub')
  const admit = path.join(dir, 'admit')
  fs.mkdirSync(path.join(hub, 'src'), { recursive: true })
  fs.writeFileSync(path.join(hub, '.hsattributes'), 'NOTES.md merge=union\n')
  fs.writeFileSync(path.join(hub, 'NOTES.md'), '# notes\n')
  fs.writeFileSync(path.join(hub, 'src', 'a.js'), 'a\n')

  const hs = (cwd, args, user = 'hub') => run(cwd, args, { ...env, USER: user })

  const init = await hs(hub, ['init'])
  t.is(init.code, 0, 'init')
  const invite = init.stdout.match(/^repo (\S+)/m)[1]
  t.is((await hs(hub, ['land', '-m', 'skeleton'])).code, 0)

  const seed = background(hub, ['seed', '--mirror', '--admit', admit], { ...env, USER: 'hub' })
  t.teardown(() => seed.stop(), { order: 1 })
  await waitFor(() => seed.output().includes('admitting'))

  for (const a of ['a1', 'a2']) {
    const res = await hs(dir, ['clone', invite, a, '--admit', admit], a)
    t.is(res.code, 0, `${a} cloned`)
  }
  await waitFor(() => seed.output().split('admitted').length === 3, 30_000).catch((err) => {
    t.comment(seed.output())
    throw err
  })
  const A1 = path.join(dir, 'a1')
  const A2 = path.join(dir, 'a2')
  for (const [cwd, user] of [
    [A1, 'a1'],
    [A2, 'a2']
  ]) {
    let last = ''
    await waitFor(async () => {
      const p = await hs(cwd, ['pull'], user)
      const i = await hs(cwd, ['info'], user)
      last = p.stdout + p.stderr + i.stdout
      return i.stdout.includes('(writable)')
    }, 30_000).catch((err) => {
      t.comment(user + ': ' + last + '\nseed: ' + seed.output())
      throw err
    })
  }
  t.pass('both agents are writers')

  // 1. concurrent NOTES appends: the second land rebases, says who moved main, no "conflict on"
  fs.appendFileSync(path.join(A1, 'NOTES.md'), '- [a1] model first\n')
  fs.writeFileSync(path.join(A1, 'src', 'model.js'), 'model\n')
  fs.appendFileSync(path.join(A2, 'NOTES.md'), '- [a2] geo next\n')
  fs.writeFileSync(path.join(A2, 'src', 'geo.js'), 'geo\n')

  const l1 = await hs(A1, ['land', '-o', '-m', 'model'], 'a1')
  t.is(l1.code, 0, 'a1 landed')
  const l2 = await hs(A2, ['land', '-o', '-m', 'geo'], 'a2')
  t.is(l2.code, 0, 'a2 landed after rebasing')
  t.comment(l2.stdout.trim().split('\n').join(' | '))
  t.ok(
    /main moved: \/NOTES\.md \(#\d+ a1\)/.test(l2.stdout),
    'names the upstream change and author'
  )
  t.ok(l2.stdout.includes('(this is normal)'))
  t.absent(l2.stdout.includes('conflict on'), 'no scary conflict line for a clean rebase')
  t.ok(
    /incoming from teammates \(1\):\n\s+#\d+ a1 .*:: model/.test(l2.stdout),
    'land lists incoming'
  )

  // 2. sync lists what came in
  const s1 = await hs(A1, ['sync'], 'a1')
  t.is(s1.code, 0)
  t.ok(/incoming from teammates \(1\):\n\s+#\d+ a2 .*:: geo/.test(s1.stdout), 'sync lists incoming')
  t.ok(fs.readFileSync(path.join(A1, 'NOTES.md'), 'utf8').includes('- [a2] geo next'))

  // 3. waiting for a dependency that landed before the wait started returns immediately
  fs.writeFileSync(path.join(A1, 'src', 'dep.js'), 'dep\n')
  t.is((await hs(A1, ['land', '-o', '-m', 'dep ready'], 'a1')).code, 0)
  const started = Date.now()
  const w = await hs(
    A2,
    ['watch', '--path', '/src/dep.js', '--count', '1', '--timeout', '30'],
    'a2'
  )
  t.is(w.code, 0, 'wait returned')
  t.ok(w.stdout.includes('/src/dep.js') && w.stdout.includes('dep ready'))
  t.ok(w.stderr.includes('your synced base'))
  t.ok(Date.now() - started < 25_000, 'did not wait for the timeout')

  // 4. a wait for something that never lands times out
  const never = await hs(
    A2,
    ['watch', '--path', '/src/never.js', '--count', '1', '--timeout', '2'],
    'a2'
  )
  t.is(never.code, 2, 'timeout exits 2')
  t.ok(never.stderr.includes('timed out'))

  // 5. a background feed: --stop stops only this worktree's feed, a restart resumes with no gap
  const feed1 = background(A2, ['watch', '--json'], { ...env, USER: 'a2' })
  await waitFor(() => fs.existsSync(path.join(A2, '.hs', 'watch.pid')))
  await sleep(3000) // let it connect and settle
  fs.writeFileSync(path.join(A1, 'src', 'f1.js'), 'f1\n')
  t.is((await hs(A1, ['land', '-o', '-m', 'f1'], 'a1')).code, 0)
  await waitFor(() => feed1.output().includes('/src/f1.js'), 30_000)
  t.pass('feed saw f1')

  const stop = await hs(A2, ['watch', '--stop'], 'a2')
  t.ok(stop.stdout.includes('stopped watcher'), 'stopped')
  await waitFor(() => feed1.exited())
  t.absent(fs.existsSync(path.join(A2, '.hs', 'watch.pid')), 'pidfile removed')

  fs.writeFileSync(path.join(A1, 'src', 'f2.js'), 'f2\n')
  t.is((await hs(A1, ['land', '-o', '-m', 'f2 while a2 feed was down'], 'a1')).code, 0)

  const feed2 = background(A2, ['watch', '--json'], { ...env, USER: 'a2' })
  await waitFor(() => feed2.output().includes('/src/f2.js'), 30_000)
  const lines = feed2
    .output()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
  t.alike(
    lines.map((l) => l.message),
    ['f2 while a2 feed was down'],
    'restarted feed resumes exactly after the last line it printed'
  )
  t.ok((await hs(A2, ['watch', '--stop'], 'a2')).stdout.includes('stopped watcher'))
  await waitFor(() => feed2.exited())
})

function run(cwd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(os.execPath(), [BIN, ...args], { cwd, env })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('exit', (code) =>
      resolve({
        code,
        stdout: b4a.toString(b4a.concat(out)),
        stderr: b4a.toString(b4a.concat(err))
      })
    )
  })
}

function background(cwd, args, env) {
  const p = spawn(os.execPath(), [BIN, ...args], { cwd, env })
  const chunks = []
  let exited = false
  p.stdout.on('data', (d) => chunks.push(d))
  p.stderr.on('data', (d) => chunks.push(d))
  p.on('exit', () => {
    exited = true
  })
  return {
    output: () => b4a.toString(b4a.concat(chunks)),
    exited: () => exited,
    async stop() {
      if (exited) return
      p.kill('SIGINT')
      await waitFor(() => exited, 10_000).catch(() => p.kill('SIGKILL'))
    }
  }
}

async function waitFor(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(100)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
