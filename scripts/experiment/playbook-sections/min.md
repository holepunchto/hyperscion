## Tasks: say what you're about to build

Duplicate work is the costliest mistake in a team. Before you start something new:

```sh
hs task                        # open tasks and who is on each (a change request is a task)
hs task start T1a2b3c          # say you're building it; waits ~1.5 s for anyone starting it too
hs task start --new "cache the distance matrix"   # something that isn't a task yet
```

- **You lead** (you started it first): build it and land as usual. A land links itself to the
  task you're on (`linked to T1a2b3c`). Close it with the land that finishes it:
  `hs land --done` (or `hs task done T1a2b3c`).
- **Someone else leads:** don't build it too (`hs task start T1a2b3c --if-free` steps away
  again at once). Ask them for a piece in NOTES.md, or review their land when it comes:
  `hs review approve 27` (or `hs review changes 27 -m "..."`), no NOTES.md land needed.
- Starting a task never blocks anyone. It lapses after 20 min without activity; `land`, `sync`
  and a running feed keep it alive. `hs task stop T1a2b3c` when you step away.
