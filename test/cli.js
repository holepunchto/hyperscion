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
  fs.writeFileSync(path.join(hub, 'src', 'pricing.js'), 'price = 1\n')
  fs.writeFileSync(path.join(hub, 'CONTRACTS.md'), '# contracts\n')
  fs.writeFileSync(path.join(hub, '.hsowners'), 'src/pricing.js a1\n')

  const timings = []
  const hs = async (cwd, args, user = 'hub') => {
    const started = Date.now()
    const res = await run(cwd, args, { ...env, USER: user })
    timings.push([Date.now() - started, user + ' ' + args.join(' ')])
    return res
  }
  t.teardown(() => {
    const slow = timings.filter(([ms]) => ms > 8000)
    if (slow.length) {
      console.log('# slow hs calls: ' + slow.map(([ms, c]) => `${c} ${ms}ms`).join('; '))
    }
  })

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
  const lf1 = await hs(A1, ['land', '-o', '-m', 'f1'], 'a1')
  t.is(lf1.code, 0, lf1.code ? lf1.stdout + lf1.stderr : 'f1 landed')
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
    .filter((l) => l.type === 'changeset')
  t.alike(
    lines.map((l) => l.message),
    ['f2 while a2 feed was down'],
    'restarted feed resumes exactly after the last line it printed'
  )
  t.ok((await hs(A2, ['watch', '--stop'], 'a2')).stdout.includes('stopped watcher'))
  await waitFor(() => feed2.exited())

  // 6. Show by default: a2 changes a file a1 owns; a1 is asked, reviews; a2 hears about it
  t.is((await hs(A2, ['sync'], 'a2')).code, 0)
  fs.writeFileSync(path.join(A2, 'src', 'pricing.js'), 'price = 2\n')
  const show = await hs(A2, ['land', '-o', '-m', 'raise price'], 'a2')
  t.is(show.code, 0, 'Show lands immediately')
  t.ok(show.stdout.includes('showing to a1 (owner of /src/pricing.js)'))
  t.ok(show.stdout.includes('review requested from a1'))
  const showSeq = Number(show.stdout.match(/landed #(\d+)/)[1])

  t.is((await hs(A1, ['pull'], 'a1')).code, 0) // status is offline: it shows what was pulled
  const st = await hs(A1, ['status'], 'a1')
  t.ok(st.stdout.includes(`review requested: #${showSeq} by a2`), 'a1 sees the request in status')
  // replaying from the start also reports a1's own lands becoming final, so read a few lines
  const req = await hs(
    A1,
    ['watch', '--for-me', '--since', '0', '--count', '20', '--timeout', '8'],
    'a1'
  )
  t.ok(req.stdout.includes(`@ #${showSeq} by a2: review requested from a1`), 'and in its feed')

  t.is((await hs(A1, ['review', '#' + showSeq, 'approve', '-m', 'ok'], 'a1')).code, 0)
  // a2 hears the approval and that its Show land is final (exactly once)
  const heard = await hs(A2, ['watch', '--for-me', '--count', '2', '--timeout', '30'], 'a2')
  t.is(heard.code, 0, heard.stdout + heard.stderr)
  t.ok(heard.stdout.includes(`@ #${showSeq} approved by a1 :: ok`), 'a2 hears the review')
  t.ok(heard.stdout.includes(`@ #${showSeq} final`), 'and that the land is final')
  t.is(heard.stdout.split(`@ #${showSeq} final`).length, 2, 'final announced once')

  // 7. Ask: a2 proposes a contract change to a1; it lands only once approved
  fs.writeFileSync(path.join(A2, 'CONTRACTS.md'), '# contracts\nplan(day) -> Plan\n')
  const prop = await hs(A2, ['propose', '-o', '-m', 'pin Plan shape', '-r', 'a1'], 'a2')
  t.is(prop.code, 0, prop.stdout + prop.stderr)
  t.ok(/proposed P1: 1 path\(s\), needs 1 approval\(s\), asked a1/.test(prop.stdout))

  const early = await hs(A2, ['land', '-o', '-m', 'pin Plan shape'], 'a2')
  t.is(early.code, 2, 'cannot land before approval')
  t.ok(early.stdout.includes('not landed, needs review: P1 has 0/1 approvals'))

  const shown = await hs(A1, ['show', 'P1'], 'a1')
  t.ok(shown.stdout.includes('proposal P1 revision 0 by a2: open'))
  t.ok(shown.stdout.includes('+plan(day) -> Plan'), 'reviewer sees the diff')
  const approve = await hs(A1, ['review', 'P1', 'approve', '-m', 'lgtm'], 'a1')
  t.ok(approve.stdout.includes('P1: approved; 1/1 approvals, approved'))

  const landed = await hs(A2, ['land', '-o', '-m', 'pin Plan shape'], 'a2')
  t.is(landed.code, 0, landed.stdout + landed.stderr)
  t.ok(/landed P1 as #\d+/.test(landed.stdout))
  t.ok((await hs(A1, ['proposals', '--all'], 'a1')).stdout.includes('P1 landed'))

  // 8. provisional -> final: the seeding hub acks, so a Ship land becomes final in seconds
  t.is((await hs(A1, ['sync'], 'a1')).code, 0)
  fs.writeFileSync(path.join(A1, 'src', 'final.js'), 'final\n')
  const fin = await hs(
    A1,
    ['land', '-o', '-m', 'wait for it', '--wait-final', '--timeout', '30'],
    'a1'
  )
  t.is(fin.code, 0, fin.stdout + fin.stderr)
  const finSeq = Number(fin.stdout.match(/landed #(\d+)/)[1])
  t.ok(fin.stdout.includes('(provisional: settles when the hub acks it)'))
  t.ok(fin.stdout.includes(`#${finSeq} final`), 'land --wait-final reports final')
  t.ok((await hs(A1, ['status'], 'a1')).stdout.includes(`last land: #${finSeq} final`))
  const log = await hs(A1, ['log', '-n', '3'], 'a1')
  t.ok(new RegExp(`#${finSeq} .*\\[final\\]`).test(log.stdout), 'log tags it final')
  const doc = await hs(A1, ['doctor'], 'a1')
  t.ok(
    /settled\s+through #\d+/.test(doc.stdout) && doc.stdout.includes('indexer      hub has seen')
  )
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
