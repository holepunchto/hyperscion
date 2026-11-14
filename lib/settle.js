// Whose acks settle a land (docs/FINALITY.md). An ack pins autobee's order only if its writer
// outweighs the writers it hasn't heard from: autobee orders concurrent nodes by writer weight,
// then timestamp. So the settlers are the indexers of weight 2 (and a heavy bootstrap writer
// still in the repo); with none, every writer, since at equal weights only "everyone has seen
// it" pins the order. A light repo's hub (milestone 7 to the finality fix) has weight 1, like
// every agent, so such repos settle on every writer.
const b4a = require('b4a')

// autobee's weight for a writer record: as granted, or derived for records made before the
// field existed (a heavy repo's indexers were granted by its weight-2 bootstrap writer)
function weightOf(w, lightBootstrap) {
  if (w.weight) return w.weight
  if (lightBootstrap) return 1
  return w.indexer ? 2 : 1
}

// writers: [{ key, value: decoded Writer record }]
function settlers(writers, { bootstrap = null, lightBootstrap = false } = {}) {
  const heavy = []
  const all = []
  let bootstrapRemoved = false
  for (const { key, value: w } of writers) {
    if (bootstrap && b4a.equals(key, bootstrap) && w.removed) bootstrapRemoved = true
    if (w.removed) continue
    if (!all.some((x) => b4a.equals(x, key))) all.push(key)
    if (w.indexer && weightOf(w, lightBootstrap) >= 2 && !heavy.some((x) => b4a.equals(x, key))) {
      heavy.push(key)
    }
  }
  const bootstrapIn = bootstrap && !bootstrapRemoved
  if (bootstrapIn && !lightBootstrap && !heavy.some((x) => b4a.equals(x, bootstrap))) {
    heavy.unshift(bootstrap)
  }
  if (heavy.length) return heavy
  if (bootstrapIn && !all.some((x) => b4a.equals(x, bootstrap))) all.unshift(bootstrap)
  return all
}

module.exports = { settlers, weightOf }
