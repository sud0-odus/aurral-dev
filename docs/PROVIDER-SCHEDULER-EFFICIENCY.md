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
- Also reports `sourceOutcomes` aggregated from `playlist_download_jobs` by `download_source` and status. This reveals queue outcomes alongside reservation utilization but does **not** measure actual active client transfers or elapsed throughput. `usenet` cannot be attributed to a specific client; `unassigned` is kept explicit.
- Existing admin settings route `GET /settings/download-clients/scheduler` already returns `getProviderSchedulerStats()` (check mounting prefix in live API before calling); no new routes or permissions added.
- No DB schema migration, no new provider commands, no queue mutation, no scheduler capacity change, no CT120 deployment.

## Validation / next steps
1. Initial PR #21 CI passed at commit `9f54fcbe`; rerun CI for subsequent commits, including source outcomes. Investigate any failures before deployment.
2. Expose or consume the augmented scheduler stats in a safe admin-only surface with no credentials/job names. Check existing download-clients runtime API from separate PR #19 before selecting route to avoid conflicts.
3. Add exact attempt phase/time metrics (search, provider wait, transfer, post-process), completion throughput, and failure reasons; do not infer phase from provider reservation alone.
4. Compare live 15m/60m ages, queue claims and provider client health. Determine whether DMM/SABnzbd work is blocked, merely searching, or failing before adjusting limits.
5. Only afterward consider independent search/download ceilings or bounded stale-attempt recovery with explicit ownership proof and tests.

## Deployment and rollback
This change is currently source-only. Don't merge/deploy until CI and staging/live-read-only verification succeed. Rollback is reverting the change to `getProviderSchedulerStats()`; there is no migration or persistent state change.

## Guardrails
Keep CT120 scheduled downloading active; do not enable Deemix or NZBGet; preserve environment files and backups. Never publish provider credentials, tokens, track names, hostnames or identifying media details in issue/PR logs.

## New live observation — subsequent CT120 snapshot (user-provided)
- Totals: 217 done, 33 downloading, 2,973 pending, 0 failed rows shown; 3,223 total. Previous snapshot was 204 done, 6 downloading, 3,012 pending, 1 failed. Status change of the failed row is not explained.
- Per-source: slskd 23 done/4 downloading/3 pending; yt-dlp 25 done/9 downloading/4 pending; usenet 20 downloading/4 pending, no completed; dmm 7 pending, no completed; unassigned 169 done/2,955 pending.
- Reservation-age query did not execute: user-facing diagnostic script had a Python f-string quoting error (`NameError: name 'provider_id' is not defined`). No ages or scheduler event counts collected yet. Do not treat the lack of data as a scheduler problem.
- Interpretation: `downloading` reflects job state and is not proof of active transfers; 33 such rows vs prior 9 reservations warrants checking claim/attempt lifecycles and provider health. Do not change provider capacity or force-release reservations based only on this snapshot.

## Reservation follow-up (user-provided, subsequent CT120 sample)
- Reservation counts and oldest age: DMM 5 / 14.6m; SABnzbd 5 / 22.5m; slskd 5 / 30.2m; yt-dlp 5 / 8.8m; **20 total reservations**.
- Scheduler `provider_selected` event counts in preceding hour: DMM 85; SABnzbd 49; slskd 19; yt-dlp 28; **181 events total**. Events are not unique tracks, transfer attempts, or completions.
- Prior queue snapshot had DMM zero completed, Usenet zero completed, slskd 23 done, yt-dlp 25 done. Different snapshot timestamps; do not treat these counts as an exact synchronized sample.
- Interpretation: all four providers have five reserved slots, and DMM/SABnzbd selection activity is high despite no observed completions. Distinguish repeated selections/retries/fallbacks from normal multi-stage work before changing scheduling behavior. A 30m reservation can be productive (slskd), so do **not** auto-expire by age.
- Next targeted investigation: correlate recent `provider_selected` events by distinct `job_id`/`attempt_id`, lifecycle outcomes by source and elapsed age, and read-only provider queue state. Confirm effective maxActive configuration and how reservations release. Avoid exposing track names or credentials.

## Latest distinct-selection and reservation-state evidence (CT120 user snapshot)
Last-hour scheduler selection events:
| Provider | Events | Distinct job IDs | Distinct attempt IDs |
| --- | ---: | ---: | ---: |
| dmm | 85 | 74 | 0 |
| sabnzbd | 49 | 49 | 0 |
| slskd | 18 | 18 | 0 |
| ytdlp | 28 | 28 | 0 |

- A count of zero distinct attempt IDs means the recorded `provider_selected` events lack `attempt_id` metadata. It does **not** mean zero attempts ran. PR #21 now populates `attemptId: payload.downloadAttemptId` when recording future selections; older rows will remain null.
- Reservation by job status: DMM 5 pending; SABnzbd 4 downloading/1 pending; slskd 4 downloading/1 pending; yt-dlp 5 downloading. A reservation attached to a pending job is not automatically invalid: verify Honker queue/attempt state and pipeline lifecycle first.
- DMM selected 74 different jobs during the window but had 0 attributed completions in the previous snapshot; investigate its outcome path, retries and source attribution instead of presuming attempts are stuck. SABnzbd likewise selected 49 distinct jobs with no attributed completed Usenet jobs in the previous snapshot.
- No scheduler dispatch or reservation lifecycle behavior changed. The extra event field is append-only metadata, best-effort, and only applies after a future deployment.

### Next measurement needed
Read-only, aggregate queries to correlate `download_provider_reservations` with Honker claims and download job states; then inspect provider-specific completion/fallback events and queue health (without titles, tokens or full request payloads). Diagnose missing completion path before implementing limits, expiring reservations or retry logic.

## Work continued — Honker claim correlation
- Traced `backend/services/downloadPipelineWorker.js`: each of 16 potential consumers obtains a durable Honker queue job. Active consumers are capped by `providerSchedulerMaxWorkers()`; `processPipelineJob()` reserves a provider for non-manual selections. When reservation is unavailable, it requeues with a 2-second delay. On terminal pipeline output it releases the reservation; on permanent failure `onFinalFailure` releases and marks failed. Reconciliation at first consumer startup validates claim existence.
- Added read-only `reservationClaims` aggregate to existing scheduler stats, grouped by provider ID, job status, and whether an exact Honker `jobId` + `downloadAttemptId` claim exists. No job IDs, titles, payloads or credentials exposed. This helps distinguish a `pending` job with a durable claim from a candidate orphan, but an absent claim alone is **not sufficient** to force release (worker transitions and in-flight operations must be considered).
- No scheduling, expiration, consumer-count, reservation-release, or provider configuration behavior changed. New stats require CI validation and deployment before visible on CT120.
- Next: validate SQLite aggregate query with tests (particularly `json_valid` and `_honker_live` schema), then correlate attempt event timeline and provider activity; do not infer actual transfer from claim existence.

## Continued work and validation checkpoint
- Added `workerCeiling` to read-only scheduler stats. This is the effective configured worker-loop ceiling, **not** the number of active transfers or durable queue claims. The distinction is important when actual job statuses exceed reservation totals.
- At the latest check, the preceding CI run had not returned a result; the most recent commit must be validated again before deployment.

## Latest development checkpoint — regression coverage
- Extracted the aggregate read-only reservation/claim SQL to `backend/services/downloadJobs/providerSchedulerReservationQuery.js`; runtime imports the shared query unchanged.
- Added `.tests/download/provider-scheduler-reservation-query.test.js` asserting exact `jobId`/`downloadAttemptId` matching, valid JSON guard, pipeline queue scoping, and no write statements. This is a **structural regression test**, not a live-SQLite fixture or proof of correct runtime queue state.
- Latest CI result must be checked at the new branch head. No changes deployed to CT120.

## In-memory SQLite integration fixture added
- `.tests/download/provider-scheduler-reservation-query.test.js` now creates an in-memory `better-sqlite3` database and runs the exact production aggregate SQL against four synthetic reservations. It tests an exact match, wrong attempt ID, wrong Honker queue, malformed JSON, and a missing job row; asserts grouped claim/no-claim counts and total conservation.
- This tests **SQL behavior**, not live Honker worker hand-off timing or actual provider download transfers. No live job state is changed.
- Test execution is subject to CI; deployment must wait for the branch's latest CI result.

## CI regression and mitigation (2026-10-19 local / 2026-10-20 UTC)
- Workflow run `39370182206` surfaced `SqliteError: no such table: _honker_live` in unit tests. Root cause: PR #21 initially prepared the reservation/claim diagnostic SQL during module initialization, before Honker created its live queue table in some test/startup paths.
- Fix commit `733f3e98106228019c4145894f857e7936e4799e`: defer preparing/running this SQL until `getProviderReservationClaimStats()` is called and check `sqlite_master` first. If Honker queue is absent, return an empty diagnostic array; this must be interpreted as unavailable, **not zero orphan reservations**.
- Await CI on the fix before deployment. No CT120 changes.

## CI and diagnostic availability update
- Corrected CI run 39370349883: production container job passed; remaining validation jobs were still running when last inspected. Do not call the full suite passed until all jobs conclude.
- Added `reservationClaimsAvailable` to stats so an absent `_honker_live` table is explicitly distinguishable from a real zero-count snapshot. Read-only schema inspection, no scheduler dispatch changes.

## Existing operational snapshot discovered during continued audit
- `backend/services/downloadJobs/downloadOperationalSnapshot.js` already computes pipeline counts, candidate stale reservations, recent event history, recent jobs, and stalled candidates. This overlaps with planned observability; reuse it instead of creating a second monitoring subsystem.
- Caution: that snapshot detects reservation candidates by comparing `updated_at` to a 30-minute threshold and filtering active job IDs from `_honker_live`, while PR #21's new diagnostic compares exact job + attempt IDs. These are different semantics and should not be treated as identical stale verdicts.
- The existing snapshot can include artist/track names and error details, so **do not expose or publish its raw payload as telemetry**. Keep the new scheduler aggregate response anonymized.
- Pipeline provider failures already record `attemptId` in `downloadPipeline.js` (`provider_failed`, `fallback`); PR #21 adds the missing `attemptId` on `provider_selected`, enabling consistent timeline correlation after deployment.
- CI workflow 39370498757: production-container validation succeeded; remaining jobs were in progress at the last observation. Wait for the full suite; do not claim it passed.

## Consolidation with existing event history
- Added `lastHourProviderEvents` to `getProviderSchedulerStats()`: per-provider event, total occurrences, distinct job IDs, and distinct attempt IDs for `provider_selected`, `provider_failed` and `fallback` from the pre-existing `download_operation_events` table. This **reuses existing persisted audit history** instead of adding a second event logger.
- All values are aggregate counts; no job names, tokens, event details, or identifiers returned. Historical selection events without attempt IDs correctly count 0 distinct attempts until new instrumented events appear.
- The pre-existing operational snapshot already consumes `getProviderSchedulerStats()`, so the new aggregate data arrives through that existing composition path without another snapshot implementation. No dispatch or queue mutations.
- Latest CI still needs to validate this commit. No CT120 deployment.

## Future admin-facing Provider Performance / Statistics page (product requirement)
The diagnostics are product-facing foundations, **not** a backend-only troubleshooting feature. Users and admins should understand which provider succeeds, which does not, when performance changes, and why—without reading logs.

### Proposed UX and metric contract
- **Admin Stats page**, linked from Settings/Tasks or Downloads, initially with provider summary cards/table: configured/enabled, maxActive, reserved, available, oldest reservation, count >15m and >60m, current source job-status counts, last-hour provider-selected/failed/fallback counts, and diagnostic availability indicator. Clearly label *reservation* vs *actual transfer*.
- **Time windows**: 1h/24h/7d (future work); history must use durable event timestamps and bounded aggregation, not only an in-memory process. A single current snapshot cannot demonstrate historical trends or success rates.
- **Reliability**: successes, failures, retries, fallback, latency percentiles, queue wait and phase durations, with denominators based on unique attempt IDs; distinguish track source (`usenet`) from underlying client (`sabnzbd` vs `nzbget`). Current job rows alone cannot provide accurate provider-attributed completion rates.
- **Explainability**: reasons grouped as auth, timeout, no match, quality/validation, network, rate limiting, fallback; mark unknown explicitly, and avoid treating scheduled jobs as completed transfers.
- **User scope**: admin-only for cross-user/provider details now; later consider privacy-safe per-user overview without identifiers or credentials.
- **Performance**: bounded indexed aggregate queries, stable named API fields with sampledAt and explicit null/unavailable distinctions; request cancellation and graceful offline states in frontend. Keep raw event details and track names out of aggregate API.
- **No tuning by heuristics until validation**: surface operational insight first; any adaptive scheduling must have separate controls and evidence of improved completion throughput without rising failure rates.

### Current implementation towards that future
- Existing admin-authenticated GET `/settings/download-clients/scheduler` returns scheduler stats. Existing operational snapshot consumes the same stats, avoiding duplicate collectors.
- Frontend now exports `fetchProviderSchedulerStats({signal})` from `frontend/src/utils/api/endpoints/settings.js` so a future admin page can poll a single endpoint without duplicating API plumbing.
- **Not yet built**: charts/cards, historical time series, verified completion attribution and phase latencies. Do not suggest these are live.
- PR #19 service toggles and Issue #22 modal fix remain separate.

## End-of-session handoff (2026-10-20)
- Admin statistics are a first-class destination, not solely backend telemetry. Preserve privacy-safe, stable aggregate metrics, explicit timestamps, and clear definitions; implementation of cards/charts and longitudinal rates remains future work.
- Most recent cleanup: `reservationClaims` is **null** if `_honker_live` does not exist and `[]` if the queue exists but no reservation-claim groups are present. This avoids confusing unavailable telemetry with zero observed claims. Older draft notes referencing `reservationClaimsAvailable` describe a prior intermediate implementation and are superseded.
- PR #21 remains a draft; no code from this branch deployed to CT120. Latest changes still require CI validation. Preserve scheduler enabled and avoid restarting during the active backlog.
- Next session: verify full CI on latest commit, fix failures, review read-only queries for efficiency and startup lifecycle, then add integration tests for event aggregation and design the admin Statistics page separately if necessary. Do not advertise throughput/success rate until completion events have reliable attribution and time windows.

## Delivery expansion — Admin statistics and adaptive capacity (2026-10-20)
- New development branch: `feat/provider-statistics-and-adaptive-capacity` based on PR #21; PR #21 itself remains unchanged and green.
- Added an admin-only Settings navigation tab, `/settings/provider-stats`, fetching the existing protected scheduler stats API every 30 seconds with abort cleanup. It shows reservation utilization, 1h selection/failure/fallback event counts, current downloading job states, claim availability, and historical *job completion event* counts per hour for 1h/24h/7d windows.
- Backend now supplies `historicalOutcomes` from the existing append-only operation event table for 1h/24h/7d. These include tracked events whose provider attribution may be missing and may include file reuse. Both UI and API deliberately **do not claim accurate per-provider download success rates** or actual transfer throughput.
- Usenet is a shared `download_source` and cannot be apportioned accurately between SABnzbd/NZBGet from job status. UI labels this limitation instead of assigning bogus provider numbers.
- **Automatic capacity tuning NOT enabled**. Do not change capacity from raw selection counts or age: prerequisite telemetry includes phase durations, attempt success/failure per provider, external-client active transfers, provider rate limits, and bounded policy tests. A future opt-in controller should have per-provider min/max, a maximum step of 1 per evaluation interval, sample thresholds, disable/circuit breaker conditions, audit trail, and instant revert to configured static limits.
- Validation needed: CI lint/build/test on expansion branch, browser QA on non-production environment, then opt-in engine only after enough real observations. PR #19 toggles remain separate.
