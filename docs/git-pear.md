# git+pear: hs and git side by side

[git+pear](https://github.com/holepunchto/gip-transport) (gip) is git over peers: `git clone
git+pear://<key>/<name>`, with no server. This page is about publishing hs's main there, as a
history of its own, for people and tools that stay on git. To continue an **existing** git
history instead (a branch on top of the commit you imported, to push to GitHub or to your own
git+pear repo), use `hs export-git`: see [Try hs next to git](trial.md) and
[Move a repo from git](from-git.md).

Some people and tools will keep using git. With [gip](https://github.com/holepunchto/gip-transport)
installed they can `git clone git+pear://…` with no server, and the hub can publish main there as a
plain git branch:

```sh
cd ../my-hub && hs seed --gip          # the hub: also publishes main and serves it; prints the link
git clone git+pear://<key>/<name>      # anyone with gip: one commit per changeset, authors kept
```

Each settled changeset becomes one commit, the same commits on every run, each with an
`Hs-Changeset: <repo>#<n>` trailer. A git user can't write the hub's repo, so they push their
commits to their own (`gip new my-fork`, then `git push git+pear://<their-key>/my-fork main`),
and a writer lands them:

```sh
hs gip import git+pear://<their-key>/my-fork   # 3-way merges what main changed meanwhile
```

The imported commits come back out as hs commits on the next publish, so the git user pulls
with `git pull --rebase`, as after a squash-merged pull request. Imports never loop, and running
one twice does nothing. A folder can be both a git checkout and an hs worktree: hs ignores
`.git`, and `hs init`/`hs clone` keep `.hs/` out of git's status.

In a hub home, a repo is published with `hs hubs gip <repo>` (or `hs hubs new <repo> --gip`): the
home's server, its service included, publishes each changeset as it settles and serves the
git+pear repo on the same connections as everything else. `hs hubs list` shows the link. Anyone
with the link can read a git+pear repo, and repos are encrypted by default, so publishing one
takes `--public`; a repo meant to be public from the start can be created with `--no-encrypt`
(`hs hubs new <repo> --gip --no-encrypt`, `hs init --no-encrypt`).
