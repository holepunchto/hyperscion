const c = require('compact-encoding')
const { compile, opt } = require('compact-encoding-struct')

const blob = compile({
  byteOffset: c.uint,
  blockOffset: c.uint,
  blockLength: c.uint,
  byteLength: c.uint,
  blockMap: c.bool,
  // key of the blobs core holding this blob, null means the drive's own blobs core
  core: opt(c.fixed32)
})

module.exports = compile({
  executable: c.bool,
  linkname: opt(c.string),
  blob: opt(blob),
  metadata: opt(c.json),
  // content hash (blake2b-256) of the blob, used for dedup and change detection
  hash: opt(c.fixed32)
})
