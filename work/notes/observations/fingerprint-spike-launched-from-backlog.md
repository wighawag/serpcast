# fingerprint-spike was also launched while its body sat in tasks/backlog/

2026-09-28: same path mismatch as `task-launched-from-backlog.md`. The runner prompt for `fingerprint-spike` pointed at `work/tasks/ready/fingerprint-spike.md` and `work/specs/ready/serpcast.md`, but in the worktree the task is in `work/tasks/backlog/` and the spec in `work/specs/tasked/`. The content matched, so the task was built; whoever does the done-move should move it from `backlog/`.
