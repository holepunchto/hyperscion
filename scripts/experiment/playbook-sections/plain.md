## The task board: say what you're about to build

Duplicate work is the costliest mistake in a team. `TASKS.md` is the team's task board: an
append-only file that merges by itself (`merge=union`). Before you start something new:

- Read `TASKS.md` on main (`hs sync`, or `hs cat /TASKS.md`).
- If nobody has taken it, append a line taking it and land that at once:
  `- [a2] taking CR-1 (pricing per flight minute)`, then `hs land -m "a2 takes CR-1"`.
- If someone took it first, don't build it too: take another piece, or ask them for one in
  `TASKS.md` or `NOTES.md`.
- When it's done, append `- [a2] done CR-1 (#27)`.
