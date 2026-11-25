const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')

test('plan day1: every package once, p19 unassigned, total adds up', () => {
  const out = JSON.parse(
    execFileSync('node', ['src/cli.js', 'plan', 'fixtures/day1.json', '--json'], {
      encoding: 'utf8'
    })
  )
  const delivered = out.trips.flatMap((t) => t.packages)
  assert.strictEqual(delivered.length + out.unassigned.length, 19)
  assert.ok(out.unassigned.some((u) => u.id === 'p19'))
  const sum = delivered.reduce((s, id) => s + out.prices[id], 0)
  assert.ok(Math.abs(sum - out.total) < 0.05)
})
