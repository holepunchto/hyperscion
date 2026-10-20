# hyperscion patches on top of hyperdrive PR #422

Base: `RaisinTen/hyperdrive#migrate-to-hyperbee2` (holepunchto/hyperdrive#422, "Migrate to
hyperbee2"), commit `01292a9`. Vendored here because the PR is open and unreviewed; swap
`"hyperdrive": "file:./vendor/hyperdrive"` in the root `package.json` for a git dependency once
these land on a branch (`"hyperdrive": "github:holepunchto/hyperdrive#<branch>"`).

The PR already breaks the entry wire format, so extending it now is cheap.

1. **`lib/encoding.js`: blobs core per entry and a content hash.**
   `blob.core` (optional `fixed32`) names the blobs core holding the blob, `null` meaning the
   drive's own. Entry gains optional `hash` (blake2b-256 of the content), used for dedup and
   change detection, since hyperblobs pointers are positional.
2. **`index.js`: resolve blobs per entry.** `getBlobsFor(blob)` returns the drive's own
   Hyperblobs or opens (and caches, shared across checkouts) the foreign blobs core.
   `get`, `createReadStream`, `has`, `clear` use it.
3. **Externally managed blobs.** `opts.blobs` is a Hyperblobs to use as the drive's own (or
   `false` for a drive whose entries all live in foreign cores, e.g. an autobee view).
   `putEntry` stamps `blob.core` on such drives, since their trees mix many blobs cores.
4. **Cross-core checkout and diff.** `checkout({ key, length })` and `diff({ key, length })`
   accept a hyperbee2 head whose root lives in another core; `drive.head` exposes `db.head()`.
5. **`del()` respects `batch()`.** Previously it always flushed its own batch.
6. **`opts.encryption`.** An encryption provider used for foreign blobs cores (takes precedence
   over `encryptionKey`).

Not changed, and not used by hyperscion on forked drives: `version`, `truncate`,
`getBlobsLength` still assume the root lives in `db.core`. hyperscion tracks versions with
hyperbee2 heads instead.

`test.js` is updated only for the two new `null` fields in decoded entries; the suite passes
94/94 under Bare.
