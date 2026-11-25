// node src/cli.js plan <day.json> [--json]
const { loadDay } = require('./model')
const { plan } = require('./scheduler')
const { price } = require('./pricing')
const { renderReport } = require('./report')

const [cmd, file, ...rest] = process.argv.slice(2)
if (cmd !== 'plan' || !file) {
  console.error('usage: node src/cli.js plan <day.json> [--json]')
  process.exit(2)
}
try {
  const day = loadDay(file)
  const p = plan(day)
  const priced = price(p, day)
  if (rest.includes('--json')) {
    console.log(JSON.stringify({ trips: p.trips, unassigned: p.unassigned, ...priced }))
  } else {
    console.log(renderReport(p, priced))
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
