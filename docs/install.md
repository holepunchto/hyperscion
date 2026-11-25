# Install

`hs` is one standalone binary. Install it once per machine; setting up a repo is a separate
step ([pick your path](../README.md#get-started-pick-your-path)).

hs is not published to npm, on purpose: there is no npm package for anyone to tamper with or
impersonate. Install it with Pear, or build it from source.

## With the Pear CLI

With the [Pear CLI](https://install.pears.com):

```sh
pear install pear://scioncigzgdpiwsr6een9suoj8irromdwor6ze9urfx9ya5sajry
```

## From source

You need git and [Node.js](https://nodejs.org) (for npm, which fetches the build tools and
libraries).

```sh
git clone https://github.com/holepunchto/hyperscion.git
cd hyperscion
npm ci --ignore-scripts        # exactly the versions in package-lock.json, no install scripts
npm run make                   # a standalone binary for this machine: out/make/hs
```

Then put `out/make/hs` on your `PATH`:

- **macOS, Linux:** `mkdir -p ~/.local/bin && cp out/make/hs ~/.local/bin/` (add
  `~/.local/bin` to your `PATH` if it isn't there yet).
- **Windows:** copy `out\make\hs.exe` into a folder on your `PATH`.

The binary has everything it needs; the checkout can go once it's copied.

**To update** a source install: `git pull`, then `npm ci --ignore-scripts && npm run make`
again, and copy the new binary over the old one.

**Working on hs itself?** Skip the build and run it straight from the checkout:
`npm i -g bare-runtime && alias hs="bare $PWD/bin.mjs"`. [Development](development.md) has the
tests.

## Check it

```sh
hs --version
hs --menu        # every command, with a form for its flags
```

## Updates

Long-running hubs update themselves over the peer-to-peer network: a hub home's service does
by default, and `hs seed --updates` or `hs hubs serve --updates` opt in
([Updates and restarts](hub-homes.md#updates-and-restarts)). One-shot commands never update, so
on a machine that doesn't run a hub, update by installing again.

## Platforms

Linux and macOS are fully supported. Windows builds and passes the quick tests, but there is no
hub service on Windows (run `hs seed` or `hs hubs serve` in a terminal), and the walkthroughs
use POSIX shell commands.

## Privacy

hs sends no telemetry and makes no HTTP calls. It finds peers on the HyperDHT, which exposes
your IP address to the DHT and to the peers you connect to. Hubs that update themselves
(`--updates`) also check the hs release link over the same network. Repos are encrypted at rest
by default; see [The hub: encryption, invites and who can write](hub.md#encryption-invites-and-who-can-write).

## Uninstall

If you ran a hub home as a service, run `hs hubs service uninstall` first. Then delete the
`hs` binary (`which hs` shows where it is). Repos are plain folders: each worktree keeps its
data in its own `.hs/`.
