# CT120 download worker watchdog recovery (2026-10-20)

## Incident evidence
- CT120 was memory/swap constrained at 2 GiB/512 MiB; cgroup I/O pressure near 99% and the backend stopped responding. CT120 was gracefully restarted with 4 GiB persistent RAM, and HTTP/SQLite reads recovered.
- Download owner repeatedly stopped responding and its supervising process SIGKILLed it at 11:06:30, 11:08:45 and 11:11:03. Startup logs show 20/20 worker slots allocated immediately; no new completed jobs beyond 843 as last observed.
- Hypotheses (not established root cause): synchronous dispatch burst and/or forced filesystem-wide link repair starving 5-second worker IPC heartbeat. The patch reduces burst size and makes repair bypass possible; it does not assert either is definitively responsible.

## Changes and scope
- Yield back to event loop after allocating at most two new jobs per dispatch call, with a scheduled continuation (250 ms minimum); keep normal configured concurrency ceiling and all durable queue records intact.
- New opt-in environment variable `AURRAL_SKIP_STARTUP_REUSE_REPAIR=1` skips only the forced startup reuse-link repair. Default remains unchanged.
- No provider policy, reservation migration, database cleanup, or queue deletion. This is separate from PR #21 and PR #23.

## Safe CT120 staging procedure (N100S host)
1. Confirm service unit and checkout paths; capture current revision, health, and counts. Do not overwrite untracked env files.
2. Once CI is green, fetch this branch in CT120 checkout, back up the existing `backend/services/downloadJobs/downloadWorker.js` with a timestamp, then use `git show FETCH_HEAD:backend/services/downloadJobs/downloadWorker.js` to replace **only that file**. Avoid a blanket `git pull` while separate unmerged GUI patches exist.
3. For initial isolation, set `AURRAL_SKIP_STARTUP_REUSE_REPAIR=1` in a temporary systemd drop-in for `aurral.service` (do not edit project secrets), `systemctl daemon-reload`, then `systemctl restart aurral` once. A service restart interrupts current download attempts; queue is persistent, but verify reclaims after.
4. For at least 5 minutes, observe worker PID stability, journal heartbeat watchdog messages, RSS, memory/swap, HTTP health, cgroup I/O pressure, and new `done` events. Avoid making more changes concurrently.
5. Roll back by restoring the backed-up file and removing the drop-in environment override; restart service once. Do not reset queue.
6. If stabilized, review startup repair separately and remove the override after fixing it. The bypass is intended as a temporary recovery guard.

**Not deployed:** GitHub PR alone does not update CT120.

## Follow-up
- Measure event-loop delay/IPC heartbeat around startup, pipeline work, and repair to establish root cause.
- Add an isolated test of burst limits with dependencies stubbed; run CI and manual CT120 verification before merging.
