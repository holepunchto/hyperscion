// The dispatch report
function renderReport(plan, priced) {
  const lines = []
  for (const t of plan.trips) {
    for (const id of t.packages) {
      lines.push(
        `${t.drone} start ${t.start.toFixed(1)} min  ${id}  ${priced.prices[id].toFixed(2)} EUR`
      )
    }
  }
  for (const u of plan.unassigned) lines.push(`unassigned ${u.id}: ${u.reason}`)
  lines.push(`total ${priced.total.toFixed(2)} EUR`)
  return lines.join('\n')
}

module.exports = { renderReport }
