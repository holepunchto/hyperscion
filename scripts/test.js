#!/usr/bin/env node
// Runs the test files in tiers, several at once (brittle-bare runs one file at a time).
//
//   node scripts/test.js [quick|integration|all] [--jobs n] [file ...]
//
// quick: everything in test/ except INTEGRATION: in-process repos, property tests, and CLI
// checks that need no team. Seconds, on every change and every CI platform.
// integration: tests that run the real `hs` binary as many processes (a hub, agents, feeds)
// over local DHT testnets. Minutes; CI runs them on one platform.
// A new test file is quick unless it is added to INTEGRATION.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
// longest first (measured), so the slowest start at once and the rest fill in around them
const INTEGRATION = [
  'test/hubs-spike.js',
  'test/site-finality.js',
  'test/flows.js',
  'test/tasks-cli.js',
  'test/outage.js',
  'test/incoming.js',
  'test/cli.js',
  'test/check.js',
  'test/outage-swarm.js',
  'test/fixes.js',
  'test/net.js',
  'test/reland.js',
  'test/ui-review.js'
]

const argv = process.argv.slice(2)
const tier = ['quick', 'integration', 'all'].includes(argv[0]) ? argv.shift() : 'quick'
const jobsAt = argv.indexOf('--jobs')
const jobs = jobsAt >= 0 ? Number(argv.splice(jobsAt, 2)[1]) : defaultJobs(tier)
const all = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => 'test/' + f)
  .sort()

for (const f of INTEGRATION) {
  if (!all.includes(f)) throw new Error(`scripts/test.js lists ${f}, which doesn't exist`)
}

const files = argv.length
  ? argv
  : tier === 'all'
    ? all
    : tier === 'integration'
      ? INTEGRATION
      : all.filter((f) => !INTEGRATION.includes(f))

// half the CPUs, at most 8 (quick) or 6 (integration: each file runs a hub, agents and
// testnets, and too many at once make their timing assertions flaky). At least 2
function defaultJobs(tier) {
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length
  return Math.max(2, Math.min(tier === 'quick' ? 8 : 6, Math.floor(cpus / 2)))
}

const bin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'brittle-bare.cmd' : 'brittle-bare'
)

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(bin, ['--timeout', '300000', file], {
      cwd: ROOT,
      shell: process.platform === 'win32'
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      const asserts = (out.match(/# asserts = (\d+)\/(\d+) pass/) || []).slice(1)
      resolve({ file, code, out, seconds: (Date.now() - started) / 1000, asserts })
    })
  })
}

async function main() {
  const started = Date.now()
  console.log(`${tier}: ${files.length} file(s), ${jobs} at a time`)
  const queue = files.slice()
  const results = []
  const worker = async () => {
    while (queue.length) {
      const r = await run(queue.shift())
      results.push(r)
      const asserts = r.asserts.length ? `${r.asserts[0]}/${r.asserts[1]}` : '-'
      console.log(
        `${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.file.padEnd(28)} ${asserts.padStart(9)} ${r.seconds.toFixed(1).padStart(6)}s`
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker))

  const failed = results.filter((r) => r.code !== 0)
  for (const r of failed) console.log(`\n==== ${r.file}\n${r.out}`)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `\n${failed.length ? 'FAIL' : 'ok'}: ${results.length - failed.length}/${results.length} files passed in ${seconds}s`
  )
  process.exitCode = failed.length ? 1 : 0
}

main()
