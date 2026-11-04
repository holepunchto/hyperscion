// Starts a local DHT testnet for manual/e2e runs and prints HS_BOOTSTRAP for it.
const createTestnet = require('hyperdht/testnet')

createTestnet(3).then((testnet) => {
  console.log(testnet.bootstrap.map((b) => b.host + ':' + b.port).join(','))
})
