# Provider scheduler efficiency — working notes

Updated: 2026-10-19 (America/Chicago)
Branch: `feat/provider-scheduler-observability`; target: `dev/aurral-3`
Status: **diagnostic-only work in draft; NOT deployed to CT120**

## Scope / why
Improve productive concurrency without indiscriminately increasing job slots or destabilizing the 3,223-job backlog. Keep this separate from PR #19 (runtime GUI toggles) and PR #20 (compact Tasks UI deployed to CT120).

## Verified CT120 baseline (user-provided read-only snapshot)
- Database: `/opt/aurral_data/aurral.db` in CT120; service working tree `/opt/aurral-3-source`, systemd working directory `/opt/aurral` (same checkout reported).
- Process environment: `AURRAL_PROVIDER_SCHEDULER=1` and `AURRAL_CT119_PAUSE_ACQUISITION=0`.
- 3,223 total jobs; subsequent snapshot: 204 done, 6 downloading, 3,012 pending, 1 failed (derived from provider breakdown; verify fresh counters before quoting live status).
- Provider-attributed done: yt-dlp 20, slskd 19; 165 previously done unassigned; DMM 5 pending, Usenet 4 pending and 1 failed. No proven root cause for DMM/Usenet noncompletion.
- Reservations in earlier snapshot: DMM 2, SABnzbd 1, slskd 3, yt-dlp 3 (9 reserved). Reservations are **not** synonymous with active transfers.
- Saved `playlistWorker.concurrency=3`; a GUI attempt to save 10 failed. The legacy value is not the operative ceiling in scheduler mode.
- Logs during/after a prior service stop included SQLite busy/locked, EPIPE and external HTTP timeout errors; causal connection to settings save is **unproven**. Avoid load-increasing changes without measurement.

## Source facts / architecture
- `backend/services/downloadJobs/downloadWorker.js` switches the worker-loop ceiling from saved legacy concurrency to `providerSchedulerMaxWorkers()` when scheduler env flag is enabled.
- `backend/services/downloadJobs/providerSchedulerRuntime.js` computes that ceiling from enabled provider `maxActive`, bounded 1–24. Reservations are SQLite rows, tied to `job_id` and `attempt_id`, with `created_at` and `updated_at`.
- A valid multistage attempt retains its provider slot until completion or fallback. Existing `reconcilePipelineReservations()` removes orphan reservations with terminal jobs or missing Honker claims; it intentionally avoids releasing live claims.
- `backend/services/downloadJobs/providerSchedulerPolicy.js` sorts provider eligibility by priority and capacity, with fairness by owner, cooldown support, and failure classification.

## What's new in this draft
- `getProviderSchedulerStats()` now exposes read-only `sampledAt` and per-provider `oldestReservationAgeMs`, `olderThan15m`, `olderThan60m`; also `unassignedReservations` for delayed provider selections.
- These are **candidate diagnostic signals**, not proof of an unhealthy job. The old reservation timestamp continues across phases, so age alone must never trigger forced release.
- No DB schema migration, no new provider commands, no queue mutation, no scheduler capacity change, no CT120 deployment.

## Validation / next steps
1. Run existing Node unit/integration tests and lint in CI. Investigate any failures before deployment.
2. Expose or consume the augmented scheduler stats in a safe admin-only surface with no credentials/job names. Check existing download-clients runtime API from separate PR #19 before selecting route to avoid conflicts.
3. Add exact attempt phase/time metrics (search, provider wait, transfer, post-process), completion throughput, and failure reasons; do not infer phase from provider reservation alone.
4. Compare live 15m/60m ages, queue claims and provider client health. Determine whether DMM/SABnzbd work is blocked, merely searching, or failing before adjusting limits.
5. Only afterward consider independent search/download ceilings or bounded stale-attempt recovery with explicit ownership proof and tests.

## Deployment and rollback
This change is currently source-only. Don't merge/deploy until CI and staging/live-read-only verification succeed. Rollback is reverting the change to `getProviderSchedulerStats()`; there is no migration or persistent state change.

## Guardrails
Keep CT120 scheduled downloading active; do not enable Deemix or NZBGet; preserve environment files and backups. Never publish provider credentials, tokens, track names, hostnames or identifying media details in issue/PR logs.
