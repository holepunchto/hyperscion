# Remote agents: a trial swarm across machines

**For you if** you've set up a trial with [Try hs next to git](trial.md) (steps 1 and 2) and
want agents on other machines to join it too: a cloud VM, a build box, a teammate's laptop.
They connect peer to peer over the same network hs always uses, with no server to stand up and
no ports to open.

Remote agents need three things from you:

1. **The hub, online.** It's how they find the repo and how their lands settle.
2. **The invite.** It's how they clone.
3. **Write access.** On your machine the admit folder grants it; from another machine you
   grant it by hand.

## 1. Keep the hub online

The hub is the `hs seed` you started in `app-trial/hub`. Keep it running for as long as
remote agents work. If the machine sleeps or goes offline, they keep working and sharing
lands with each other, but nothing settles until the hub is back, and `hs export-git` only
exports settled work ([The hub](hub.md)).

For a long or overnight run, a machine that stays up is a better home for the hub than a
laptop: see [Running the hub elsewhere](hub.md#running-the-hub-elsewhere).

## 2. Send the invite

In the trial worktree:

```sh
cd ~/code/app-trial/swarm
hs info            # the `invite` line
```

**Treat the invite like a password.** Anyone who has it can read the repo. If the code is
private and the invite may travel through chat or tickets, start the trial with
`hs init --as me --hub ../hub --encrypt` instead. That keeps the repo's data encrypted at rest,
and the invite then carries the key.

## 3. Clone on the remote machine

On the remote machine, [install hs](install.md), then clone. Pick a handle for the agent: it's
how it shows up in `hs log` and as the author of its commits on your branch.

```sh
hs clone <invite> agent-3 --as a3
```

```
cloned <repo> at #1 into /home/you/agent-3: 3 file(s)
writer key (share with a writer to get access): 5kirrwj4fcgc8k7oecgmj8mq938nk3caczzigtdz14osmar4xt8y
```

Send the writer key back to whoever runs the hub. It's a public key, so it's safe in chat.

## 4. Grant write access, on the hub's machine

The running `hs seed` holds the hub's store, so stop it for a moment:

```sh
cd ~/code/app-trial/hub
# stop hs seed (ctrl+c in its terminal), then:
hs add-writer <writer key> --as a3
hs seed --admit ../admit             # start it again
```

Agents already working barely notice: their lands stay provisional for those few seconds and
settle once the hub is back.

## 5. Start the agent

Back on the remote machine:

```sh
cd agent-3
hs fetch           # picks up the grant
hs info            # the writer line now ends in (writable)
```

Then give the agent its task and the playbook, as for local agents (`hs agents`, see
[step 2 of the trial](trial.md#2-bring-in-the-agents)). It lands, watches and claims tasks
exactly like the agents on your machine, and its work comes out in `hs export-git` with the
rest, under its handle.

## Taking access away, and cleaning up

`hs revoke a3`, in `app-trial/swarm`, ends an agent's write access: every peer ignores what it
writes from then on. It keeps what it already has, and can still read with the invite.

When the trial is over, the remote machine only has its own `agent-3` folder to delete.

## If it doesn't connect

- `hs doctor`, on the remote machine, says whether it reaches the hub and what it's waiting
  for.
- hs connects through most home and office networks without any setup. A network that blocks
  UDP entirely can stop it; try the agent from another network to tell.
