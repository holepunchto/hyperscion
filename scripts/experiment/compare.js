// Compare rounds side by side from each team dir's metrics.json (written by analyze.js).
//   node scripts/experiment/compare.js <teamdir> <teamdir> ...
const fs = require('fs')
const path = require('path')

const dirs = process.argv.slice(2)
if (!dirs.length) {
  console.error('usage: node scripts/experiment/compare.js <teamdir> <teamdir> ...')
  process.exit(1)
}

const rounds = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'metrics.json'), 'utf8')))
const keys = [...new Set(rounds.flatMap((r) => Object.keys(r)))]
const names = dirs.map((d) => path.basename(path.resolve(d)))

console.log(`| metric | ${names.join(' | ')} |`)
console.log(`|---|${names.map(() => '---').join('|')}|`)
for (const k of keys) {
  console.log(`| ${k} | ${rounds.map((r) => (k in r ? JSON.stringify(r[k]) : '-')).join(' | ')} |`)
}
