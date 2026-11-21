# hyperscion

Peer-to-peer source control for agent-scale change volume, built on the Holepunch stack:
[hyperbee2](https://github.com/holepunchto/hyperbee2),
[autobee](https://github.com/holepunchto/autobee),
[hyperdrive on hyperbee2](https://github.com/holepunchto/hyperdrive/pull/422) and
[blind peers](https://github.com/holepunchto/blind-peering). It ships as a standalone
[Bare](https://github.com/holepunchto/bare) binary, `hs`.

> [!NOTE]
> This is an experimental Pear Labs project. It works and is safe to try, but it is not officially supported by Tether/Holepunch and may change, break, or disappear at any time.

> Pear Labs projects are built by members of the Pear and Platform team, often outside of regular feature work, to explore ideas and show what's possible on the platform. They have been given a light review and are considered trustworthy to install and run, but they do not carry the guarantees of our first-class software.
> There is no commitment to maintenance, backwards compatibility, security response times, or long-term availability, and they should not be relied on for anything critical. Use them to learn, test, and have fun - and please send feedback, but treat them as experiments rather than products.

hyperscion takes the ideas behind Anthropic's
[Scion](https://www.anthropic.com/engineering/redesigning-source-control) and asks how far a
system can get without a server:

- **Workspaces fork main in O(1).** A workspace's tree is rooted directly in main's B-tree, in
  another peer's core.
- **Commits cost O(change).** Only the dirty root-to-leaf paths are written.
- **Lands are lock-free.** Main is a multiwriter autobee. Every peer deterministically accepts
  or rejects a land by path-level optimistic concurrency, with a self-verifying hash-chain base.
  There is no merge queue.
- **Reads are lazy and verifiable.** Peers fetch exactly the blocks they read, from anyone,
  and merkle proofs mean no cache can lie.
- **Data stays available without a server.** Mirror peers (`hs seed`) or blind peers
  that hold encrypted blocks they cannot read.

> [!NOTE]
> This an experimental library. A version 1.0.0 release will signal stability. Until that point be very careful about data/file loss.

This is a milestone-1 prototype. **[docs/DESIGN.md](docs/DESIGN.md)** has the architecture, the
Scion mapping, the measured results (including where git still wins) and the open problems.

## Install

```sh
pear install pear://scioncigzgdpiwsr6een9suoj8irromdwor6ze9urfx9ya5sajry   # with the Pear CLI
npm init hyperscion                                                        # or with npm
```

[docs/install.md](docs/install.md) has the details, installing from source, and uninstalling.
Installing gives you the `hs` command; setting up a repo is the next step.

## Get started: pick your path

**Where is your code now, and what do you want from hs?**

| your code is…                                                        | and you want…                                                                                           | read                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| nowhere yet, or a folder that isn't in git                           | to start a repo in hs                                                                                   | **[Start a new repo](docs/start.md)**        |
| in git (GitHub, GitLab, any remote, or [git+pear](docs/git-pear.md)) | the team (people and agents) working in hs from now on                                                  | **[Move a repo from git](docs/from-git.md)** |
| in git, and staying there                                            | a swarm of agents on one feature or big chunk of work for a while, then the result back as a git branch | **[Try hs next to git](docs/trial.md)**      |

Not sure? Start with the last one. A trial lives in a side folder next to your git checkout,
needs nobody else on the team to install anything, and ends with an ordinary git branch and a
folder you delete.

## How it works, briefly

- **main** is the shared history: numbered changesets (`#27`), each with an author, a message
  and the files it touched. **Your worktree** is a private fork of main that costs nothing.
- **`hs land`** puts your changes on main: it commits, rebases onto teammates' work if they
  touched the same files, and retries, with no locks and no merge queue. **`hs sync`** brings
  their work in. **`hs watch`** streams lands as they happen, so nobody polls.
- **The hub** is a team's always-on peer. It makes lands final and holds everything landed. Work
  carries on while it's down; lands just stay provisional until it's back.
  [The hub](docs/hub.md) explains why there is one and how to run, replace and back it up.
- **Agents** follow a playbook ([docs/AGENTS.md](docs/AGENTS.md)) and claim work with tasks
  ([docs/TASKS.md](docs/TASKS.md)) so two of them don't build the same thing.

## Documentation

| page                                     | what                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| [Install](docs/install.md)               | Pear, npm, from source; updates; uninstalling                          |
| [Start a new repo](docs/start.md)        | try it on your machine, run your hub for real, bring in teammates      |
| [Move a repo from git](docs/from-git.md) | import git history, move the team, mirror or retire the old remote     |
| [Try hs next to git](docs/trial.md)      | a swarm of agents in a side folder; the result back as a git branch    |
| [git+pear](docs/git-pear.md)             | main as a git repo for git users and tools; landing their commits      |
| [Commands](docs/commands.md)             | every command, `hs ui`, `hs --menu`, a git cheat sheet, ignoring files |
| [The hub](docs/hub.md)                   | what it does, running it, failure, replacing it, backups               |
| [Hub homes](docs/hub-homes.md)           | many repos from one hub process, as a service, with updates            |
| [Agent playbook](docs/AGENTS.md)         | how an agent works in a team with hs                                   |
| [Tasks](docs/TASKS.md)                   | claiming work, splitting it, approvals                                 |
| [Finality](docs/FINALITY.md)             | provisional, settled, final, and why                                   |
| [Design](docs/DESIGN.md)                 | architecture, measurements, open problems                              |
| [Development](docs/development.md)       | tests, benchmarks, building the binary, the library API                |

## License

Apache-2.0
