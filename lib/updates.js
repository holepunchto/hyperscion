// Peer-to-peer OTA updates (from the hello-pear-bare template) for long-running hubs (`hs seed`,
// `hs hubs serve`). One-shot commands never update mid-flight.
//
// The worker finds a release, waits a random delay of up to an hour (so a fleet doesn't fetch
// at once), downloads it and replaces the binary on disk. The running process keeps its code
// until it restarts: `onapplied` is when that is worth doing.
const path = require('bare-path')
const os = require('bare-os')
const { persistent } = require('bare-storage')
const { isWindows } = require('which-runtime')
const pkg = require('../package.json')
const self = require('./self')

const PLACEHOLDER = 'pear://<YOUR_KEY_HERE>'

module.exports = async function startUpdates(log, { onapplied = null } = {}) {
  if (!pkg.upgrade || pkg.upgrade === PLACEHOLDER) {
    log('updates: no upgrade link in package.json (create one with `pear touch`), skipping')
    return null
  }

  const App = require('../app.js')
  const appName = pkg.productName || pkg.name
  const isDev = self.isDev()

  const app = new App({
    dir: isDev ? path.join(os.tmpdir(), 'pear', appName) : path.join(persistent(), appName),
    app: isDev ? null : os.execPath(),
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? appName + '.exe' : appName
  })

  app.on('updating', () => log('[updater] getting new update'))
  app.on('updated', () => log('[updater] update complete... applying'))
  app.on('update-applied', () => {
    if (onapplied) return onapplied()
    log('[updater] applied update, restart to run it')
  })
  app.on('error', (err) => log('[updater] ' + err.message))
  // the worker's other messages: without these a scheduled update looks like a dead updater
  // for up to an hour
  app.on('message', (message) => {
    const [kind, ...rest] = message.split(' ')
    const detail = rest.join(' ')
    if (kind === 'update-scheduled') {
      log(`[updater] update found; fetching it in ${Math.round(Number(detail) / 60000)} min`)
    } else if (kind === 'updater-error' || kind === 'pear:updateFailed') {
      log('[updater] ' + (detail || kind))
    }
  })

  await app.ready()
  log(
    `updates: enabled (${pkg.upgrade})` +
      (isDev ? '; in a checkout an update never replaces this code' : '')
  )
  return app
}
