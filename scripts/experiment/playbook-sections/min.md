## Claims: say what you're about to build

Duplicate work is the costliest mistake in a team. Before you start something new:

```sh
hs claims                      # open items and who is on them (a change request is an item)
hs claim C1a2b3c               # say you're on it; waits ~1.5 s for anyone claiming at once
hs claim --new "cache the distance matrix"     # something that isn't an item yet
```

- **You lead** (the earliest claim): build it and land as usual. A land links itself to the
  item you're on (`linked to C1a2b3c`). Close it with the land that finishes it: `hs land --done` (or `hs claim C1a2b3c --done`).
- **Someone else leads:** don't build it too (`hs claim C1a2b3c --if-free` withdraws your claim at once). Ask them for a piece in NOTES.md, or review
  their land when it comes: `hs review #27 approve` (or `changes -m "..."`), no NOTES.md land
  needed.
- A claim never blocks anyone. Claims expire after 20 min without activity; `land` and `sync`
  keep yours alive. `hs claim C1a2b3c --release` when you stop.
