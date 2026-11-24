// The drive entry encoding (vendor/hyperdrive/lib/encoding.js) sits inside every land op and
// every files/ record: it is part of main's history. hs owns it now (the vendored hyperdrive
// is a fork of an unmerged PR), so these golden bytes pin it: an update of the vendored copy
// that changes how entries encode fails here instead of moving history (decided 2026-11-24).
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const driveEntry = require('hyperdrive/lib/encoding')

const K = b4a.alloc(32, 7)
const H = b4a.alloc(32, 9)
const GOLDEN = [
  [
    'a file with a blob in another core and a hash',
    {
      executable: false,
      linkname: null,
      blob: {
        byteOffset: 10,
        blockOffset: 2,
        blockLength: 3,
        byteLength: 300,
        blockMap: false,
        core: K
      },
      metadata: null,
      hash: H
    }
  ],
  [
    'an executable with no blob',
    { executable: true, linkname: null, blob: null, metadata: null, hash: null }
  ],
  [
    'a symlink',
    { executable: false, linkname: '../x.txt', blob: null, metadata: null, hash: null }
  ],
  [
    'metadata',
    { executable: false, linkname: null, blob: null, metadata: { mode: 420 }, hash: null }
  ]
]

// the bytes as of the pre-release freeze; regenerate only with a new repo ABI
const EXPECTED = [
  '4c000a22000107070707070707070707070707070707070707070707070707070707070707070a0203fd2c0100090909090909090909090909090909090909090909090909090909090909090900',
  '02000001',
  '0b0001082e2e2f782e74787400',
  '0f00040c7b226d6f6465223a3432307d00'
]

test('drive entries encode exactly as at the freeze', (t) => {
  GOLDEN.forEach(([name, entry], i) => {
    const hex = b4a.toString(c.encode(driveEntry, entry), 'hex')
    t.is(hex, EXPECTED[i], name)
    t.alike(c.decode(driveEntry, b4a.from(hex, 'hex')), entry, name + ': round trip')
  })
})
