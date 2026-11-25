# hyperscion

Peer-to-peer source control for agent-scale change volume, built on the Holepunch stack:
[hyperbee2](https://github.com/holepunchto/hyperbee2),
[autobee](https://github.com/holepunchto/autobee),
[hyperdrive on hyperbee2](https://github.com/holepunchto/hyperdrive/pull/422) and
[blind peers](https://github.com/holepunchto/blind-peering). It ships as a standalone
[Bare](https://github.com/holepunchto/bare) binary, `hs`.

> [!NOTE]
> This is an experimental Pear Labs project, ready for experiments on non-sensitive code. It is not officially supported by Tether/Holepunch and may change, break, or disappear at any time. Before inviting a team, read what an invite gives away and who can change who writes: [The hub: encryption, invites and who can write](docs/hub.md#encryption-invites-and-who-can-write).

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
  that hold encrypted blocks they cannot read (repos are encrypted unless made with
  `--no-encrypt`).

## Install

With the [Pear CLI](https://install.pears.com):

```sh
pear install pear://scioncigzgdpiwsr6een9suoj8irromdwor6ze9urfx9ya5sajry
```

Or build it from source (needs git and Node.js):

```sh
git clone https://github.com/holepunchto/hyperscion.git && cd hyperscion
npm ci --ignore-scripts && npm run make   # a standalone binary for this machine: out/make/hs
cp out/make/hs ~/.local/bin/              # or anywhere on your PATH
```

hs isn't published to npm. [docs/install.md](docs/install.md) has the details and uninstalling.
Installing gives you the `hs` command; setting up a repo is the next step.

## Get started: pick your path

**Where is your code now, and what do you want from hs?**

| your code is…                                                        | and you want…                                                                                           | read                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| nowhere yet, or a folder that isn't in git                           | to start a repo in hs                                                                                   | **[Start a new repo](docs/start.md)**                                       |
| anywhere, and you already run a hub                                  | another repo on the same hub                                                                            | **[Another repo](docs/start.md#4-another-repo-when-you-already-run-a-hub)** |
| in git (GitHub, GitLab, any remote, or [git+pear](docs/git-pear.md)) | the team (people and agents) working in hs from now on                                                  | **[Move a repo from git](docs/from-git.md)**                                |
| in git, and staying there                                            | a swarm of agents on one feature or big chunk of work for a while, then the result back as a git branch | **[Try hs next to git](docs/trial.md)**                                     |

Not sure? Start with the last one. A trial lives in a side folder next to your git checkout,
needs nobody else on the team to install anything, and ends with an ordinary git branch and a
folder you delete.

## For experimenters

This first release (0.3) is for teams trying hs on real, non-sensitive work. Start with
**[Try hs next to git](docs/trial.md)**: it needs no one else to install anything and ends with
a git branch. Repos are encrypted by default, and the invite works like a password.

What helps most is what an agent or a person found confusing, slow or wrong: the command, what
it printed, and what you expected. Open an issue on the repository. `hs doctor` output and
`hs --version` help us reproduce it. Repos keep working across hs updates: new rules ship
switched off until a repo owner runs `hs upgrade-repo`
([Versions](docs/hub.md#versions-hs-releases-and-the-repo-abi)).

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

## From the experiments

We test hs with teams of AI agents and keep the traces. In the latest runs, three agents
sharing a change request rated hs **5/5 against plain git**, all three, in two runs in a
row (`q0b-to5-3` and `q0b-to5-5`): it was built once, main stayed green, and the two who didn't
build it were told at once that they were its reviewers and what to run next
([how it got there](docs/WINS.md#three-agents-rated-hs-55-against-git-twice-in-a-row)).

Another example: an Opus lead delegated a change to two Haiku workers. Without a check gate, a
worker's contract-breaking change landed, the lead approved it about 10 seconds later without an `hs show` of it, and main
stayed broken for 3.4 minutes. With the repo's checks declared in `/.hschecks`, a land like
that is refused with the exact mismatch. [docs/WINS.md](docs/WINS.md) collects cases like
this, with the runs they come from.

## Documentation

| page                                     | what                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| [Install](docs/install.md)               | Pear or from source; updates; privacy; uninstalling                    |
| [Start a new repo](docs/start.md)        | try it on your machine, run your hub for real, bring in teammates      |
| [Move a repo from git](docs/from-git.md) | import git history, move the team, mirror or retire the old remote     |
| [Try hs next to git](docs/trial.md)      | a swarm of agents in a side folder; the result back as a git branch    |
| [Remote agents](docs/trial-remote.md)    | a trial swarm with agents on other machines                            |
| [git+pear](docs/git-pear.md)             | main as a git repo for git users and tools; landing their commits      |
| [Commands](docs/commands.md)             | every command, `hs ui`, `hs --menu`, a git cheat sheet, ignoring files |
| [The hub](docs/hub.md)                   | what it does, running it, failure, replacing it, backups               |
| [Hub homes](docs/hub-homes.md)           | many repos from one hub process, as a service, with updates            |
| [Agent playbook](docs/AGENTS.md)         | how an agent works in a team with hs                                   |
| [Tasks](docs/TASKS.md)                   | claiming work, splitting it, approvals                                 |
| [Checks](docs/CHECKS.md)                 | repo-declared checks: `/.hschecks`, `hs check`, required checks        |
| [Wins](docs/WINS.md)                     | runs where hs changed the outcome, with the traces                     |
| [Finality](docs/FINALITY.md)             | provisional, settled, final, and why                                   |
| [Design](docs/DESIGN.md)                 | architecture, measurements, open problems                              |
| [History](docs/history/README.md)        | design records and decisions behind hs, with the runs that drove them  |
| [Development](docs/development.md)       | tests, benchmarks, building the binary, the library API                |

## License

Apache-2.0
