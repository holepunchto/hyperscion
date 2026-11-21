# Install

`hs` is one standalone binary. Install it once per machine; setting up a repo is a separate
step ([pick your path](../README.md#get-started-pick-your-path)).

## With the Pear CLI

With the [Pear CLI](https://install.pears.com):

```sh
pear install pear://scioncigzgdpiwsr6een9suoj8irromdwor6ze9urfx9ya5sajry
```

## With npm

```sh
npm init hyperscion
```

That's `npm init`, not `npm install`: npm runs the `create-hyperscion` package, which fetches
the `hs` binary peer-to-peer with [pear-install](https://www.npmjs.com/package/pear-install)
(what `pear install` uses) and puts it in `~/.local/bin/hs` on macOS and Linux, or
`%LOCALAPPDATA%\Programs\hs\hs.exe` on Windows. `npm init -y hyperscion` skips the question.
The npm package is only the installer (a few kB, no dependencies); the binary comes from peers.

## From a checkout of this repo

```sh
npm install && alias hs="bare $PWD/bin.mjs"
```

[Development](development.md) has the tests and how to build the binary.

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

## Uninstall

If you ran a hub home as a service, run `hs hubs service uninstall` first. Then delete the
`hs` binary: the npm installer puts it in `~/.local/bin/hs` (macOS, Linux) or
`%LOCALAPPDATA%\Programs\hs\hs.exe` (Windows), and `which hs` shows where any install put it.
Repos are plain folders: each worktree keeps its data in its own `.hs/`.
