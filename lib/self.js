// How to run hs again from inside hs: in a checkout it is `bare bin.mjs`, so the script comes
// first; the standalone binary (bare-build) is hs itself, and the script path is only a name
// inside its bundle. bin.mjs reads argv the same way.
const path = require('bare-path')
const os = require('bare-os')
const { isWindows } = require('which-runtime')

const BIN = path.join(__dirname, '..', 'bin.mjs')

function isDev(argv0 = Bare.argv[0]) {
  return path.basename(argv0) === (isWindows ? 'bare.exe' : 'bare')
}

// [executable, args] that run `hs <args>`
function selfCommand(args, argv0 = Bare.argv[0]) {
  return [os.execPath(), isDev(argv0) ? [BIN, ...args] : args]
}

module.exports = { isDev, selfCommand, BIN }
