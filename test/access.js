// `hs access` lists who can write and what reading takes; `hs revoke` takes a writer out, and
// the hub's admit folder doesn't let a revoked key back in
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { team, waitFor } = require('./helpers/team')

test(
  'access lists the team; revoke takes a writer out for everyone',
  { timeout: 180000 },
  async (t) => {
    const tm = await team(t)
    const owner = path.join(tm.dir, 'owner')

    const listed = await tm.hs(owner, ['access'], 'owner')
    t.is(listed.code, 0, listed.stderr)
    const row = (out, handle) => out.split('\n').find((l) => l.startsWith(handle + ' '))
    t.ok(/\bowner\s+active\b/.test(row(listed.stdout, 'owner')), 'the owner: ' + listed.stdout)
    t.ok(/\bhub\s+active\b/.test(row(listed.stdout, 'hub')), 'the hub')
    t.ok(/\bagent\s+active\b/.test(row(listed.stdout, 'a1')), 'a1, an agent')
    t.ok(row(listed.stdout, 'owner').includes('(you)'), 'says which one is you')
    t.ok(listed.stdout.includes('read: anyone with the invite'), 'what reading takes')

    // the guards
    const notOwner = await tm.as('a1', ['revoke', 'owner', '--offline'])
    t.is(notOwner.code, 1, 'an owner needs --force: ' + notOwner.stderr.trim())
    const notHub = await tm.as('a1', ['revoke', 'hub', '--offline'])
    t.ok(notHub.code === 1 && /replace it/.test(notHub.stderr), 'a hub is replaced, not revoked')
    const notSelf = await tm.as('a1', ['revoke', 'a1', '--offline'])
    t.is(notSelf.code, 1, 'not yourself')

    const a2Key = (await tm.as('a2', ['info'])).stdout.match(/^writer\s+(\S+)/m)[1]
    const revoked = await tm.hs(owner, ['revoke', 'a2'], 'owner')
    t.is(revoked.code, 0, revoked.stderr)
    t.ok(revoked.stdout.includes('revoked a2') && revoked.stdout.includes('pushed'), revoked.stdout)
    t.ok(revoked.stdout.includes('does not do'), 'says what revoking does not do')
    const again = await tm.hs(owner, ['revoke', 'a2'], 'owner')
    t.ok(again.stdout.includes('already removed'), 'revoking twice says so')

    // a teammate sees it
    await waitFor(async () => {
      const res = await tm.as('a1', ['access', '--json'])
      if (res.code !== 0) return false
      const a2 = JSON.parse(res.stdout).writers.find((w) => w.handle === 'a2')
      return a2 && a2.status === 'removed'
    }, 30_000)
    t.pass('a1 sees a2 removed')

    // a2's land is ignored: main doesn't get it
    tm.write('a2', 'A2.md', 'after revoke\n')
    const land = await tm.as('a2', ['land', '-m', 'after revoke', '--no-wait'])
    await tm.as('a1', ['sync'])
    t.ok(land.code === 1 && /access was revoked/.test(land.stderr), 'a2 is told: ' + land.stderr)
    t.absent(tm.read('a1', 'A2.md'), 'what a2 lands after the revoke never reaches main')

    // dropping the key in the admit folder again doesn't let it back in
    fs.writeFileSync(path.join(tm.dir, 'admit', 'a2.key'), a2Key + '\n')
    await waitFor(() => tm.seed.output().includes('not admitting a2.key'), 30_000)
    t.pass('the hub does not re-admit a revoked key')
    const still = JSON.parse((await tm.hs(owner, ['access', '--json'], 'owner')).stdout)
    t.is(still.writers.find((w) => w.handle === 'a2').status, 'removed', 'still removed')
    const hub = still.writers.find((w) => w.handle === 'hub')
    t.ok(hub.lastWrite > 0, 'the hub acks, so its last write follows main')

    // status after a pull: main moved on, the workspace hasn't taken it in yet
    fs.writeFileSync(path.join(owner, 'MORE.md'), 'more\n')
    const more = await tm.hs(owner, ['land', '-m', 'more'], 'owner')
    t.is(more.code, 0)
    const moreSeq = Number(more.stdout.match(/landed #(\d+)/)[1])
    const after = await tm.hs(owner, ['access'], 'owner')
    t.ok(
      new RegExp(`^owner .*landed #${moreSeq}, \\d+s ago`, 'm').test(after.stdout),
      'last active is your own last land: ' + after.stdout
    )
    t.ok(/^hub .*acked #\d+/m.test(after.stdout), 'a hub shows how far it acked')
    t.is((await tm.as('a1', ['fetch'])).code, 0)
    const st = await tm.as('a1', ['status'])
    t.ok(/main is at #\d+: `hs sync` brings in 1 changeset\(s\)/.test(st.stdout), st.stdout)
    await tm.as('a1', ['sync'])
    t.absent((await tm.as('a1', ['status'])).stdout.includes('main is at'), 'gone after sync')
  }
)
