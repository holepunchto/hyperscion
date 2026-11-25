// Checks the code against CONTRACTS.md:
// - every function a section names exists in its modules, and every function a module exports
//   is named in its section (src/cli.js exports nothing);
// - `node src/cli.js plan fixtures/day1.json --json` prints exactly the keys the cli line pins.
//   node scripts/contracts.js      exit 0 when they agree; one line per mismatch otherwise
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const text = fs.readFileSync(path.join(root, 'CONTRACTS.md'), 'utf8')
const problems = []

const sections = text.split(/^## /m).slice(1)
for (const s of sections) {
  const heading = s.split('\n')[0]
  const modules = heading
    .replace(/\(.*\)/, '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== 'cli')
  const named = new Set([...s.matchAll(/`([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))
  const exported = new Map()
  for (const m of modules) {
    const file = path.join(root, 'src', m + '.js')
    if (!fs.existsSync(file)) {
      problems.push(`CONTRACTS.md "## ${heading}": no src/${m}.js`)
      continue
    }
    let mod
    try {
      mod = require(file)
    } catch (err) {
      problems.push(`src/${m}.js: cannot load: ${err.message.split('\n')[0]}`)
      continue
    }
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === 'function' && !/^[A-Z]/.test(k)) exported.set(k, m)
    }
  }
  for (const n of named) {
    if (!exported.has(n)) {
      problems.push(
        `CONTRACTS.md names ${n}() but ${modules.map((m) => 'src/' + m + '.js').join(' / ')} do not export it`
      )
    }
  }
  for (const [k, m] of exported) {
    if (!named.has(k)) {
      problems.push(`src/${m}.js exports ${k}() but CONTRACTS.md "## ${heading}" does not name it`)
    }
  }
}

const shape = text.match(/--json`? prints `\{([^}]*)\}`/)
if (!shape) {
  problems.push('CONTRACTS.md: no "`--json` prints `{ ... }`" line for the cli')
} else {
  const want = shape[1]
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .sort()
  let got = null
  try {
    const out = execFileSync('node', ['src/cli.js', 'plan', 'fixtures/day1.json', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    got = Object.keys(JSON.parse(out)).sort()
  } catch (err) {
    problems.push(
      'src/cli.js plan fixtures/day1.json --json failed: ' + String(err.message).split('\n')[0]
    )
  }
  if (got && got.join() !== want.join()) {
    problems.push(
      `--json prints { ${got.join(', ')} } but CONTRACTS.md pins { ${want.join(', ')} }`
    )
  }
}

for (const p of problems) console.error('contracts: ' + p)
if (problems.length) process.exit(1)
console.log('contracts: CONTRACTS.md matches the code')
