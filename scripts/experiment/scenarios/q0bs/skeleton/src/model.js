// Day files: load and validate
const fs = require('fs')

class DayError extends Error {}

function loadDay(file) {
  let day
  try {
    day = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new DayError(`cannot read day file ${file}: ${err.message}`)
  }
  for (const k of ['depots', 'drones', 'packages']) {
    if (!Array.isArray(day[k])) throw new DayError(`day file: ${k} must be a list`)
  }
  const depots = new Set(day.depots.map((d) => d.id))
  for (const d of day.drones) {
    if (!depots.has(d.depot)) throw new DayError(`drone ${d.id}: unknown depot ${d.depot}`)
  }
  return {
    serviceMinutes: day.serviceMinutes || 0,
    dayLengthMinutes: day.dayLengthMinutes || 600,
    depots: day.depots,
    drones: day.drones,
    packages: day.packages
  }
}

module.exports = { loadDay, DayError }
