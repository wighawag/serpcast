# libcurl-install-and-doctor was also launched while its body sat in tasks/backlog/

2026-09-28: same path mismatch as `task-launched-from-backlog.md`. The runner prompt pointed at `work/tasks/ready/libcurl-install-and-doctor.md` and `work/specs/ready/serpcast.md`, but in the worktree the task is in `work/tasks/backlog/` and the spec in `work/specs/tasked/`. Its `blockedBy` (`searchcast-engine`) is done and the content matched the prompt, so the task was built; whoever does the done-move should move it from `backlog/`.
