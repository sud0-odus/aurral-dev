# Provider-aware scheduler redesign (Issue #12)

## Audit at baseline `5a8d9f70`

- `downloadJobs/downloadWorker.js` limits initial handoffs with `activeCount + countSearchingPipelineJobs()` and defaults to three; this is a global search gate, not capacity accounting for each external provider.
- `downloadPipelineWorker.js` defines a default one-consumer `slskd-pipeline`; optional second consumer claims the **same** Honker queue. More shared consumers do not establish provider-level capacity.
- `downloadPipeline.js` chooses providers sequentially via `buildNextSourcePayload`; a job can occupy queue time searching/polling while other configured clients are idle.
- `downloadSourceService.js` maps SABnzbd and NZBGet onto the single `usenet` source ID; `usenetOrchestrator.js` chooses SABnzbd preferentially unless a client is explicitly selected. Independent clients need separate scheduling IDs but should reuse the verified Usenet adapter.
- `downloadJobs/mutationGuards.js` applies playlist-level download-step locks around pipeline processing. Relaxing these safely will require atomic per-track ownership and import fencing.
- Existing cancellation attempt IDs, playlist generations, Honker claims and commit locks provide useful primitives; preserve their semantics.
- `downloadJobs/downloadTracker.js` holds pending/retry queues and album groups; album fallback currently re-releases missing member jobs. Preserve this and DMM partial-edition behavior.

## Increment 1 (committed): pure, isolated scheduling policy

`downloadJobs/providerSchedulerPolicy.js` supports independent IDs (`slskd`, `ytdlp`, `sabnzbd`, `nzbget`, `deemix`, `dmm`), priority overflow, capacity, cooldown, job-type filtering, per-client tried lists, playlist fairness, active-attempt exclusion and bounded retry/fallback decisions. This is **not** activated by default, and is **not** a durable dispatcher. Its active counts must come from authoritative persisted reservations and external client telemetry; calling this policy alone does not guarantee exclusivity. The new standalone tests cover core decisions only.

## Remaining implementation sequence

1. Persist separate scheduler job/attempt rows and atomic provider slot claims. Include job ID, client ID, source, attempt UUID, generation/fence, state, timestamps, heartbeat/lease expiry, reason, retry count, next-eligible timestamp. Place a uniqueness constraint on live attempts per track. Migrate without deleting legacy Honker rows, with a reversible feature flag.
2. Create a single dispatch owner that reads committed claims and reconciles external client activity. A slot is a reservation covering search through import or cleanup, not merely a Honker dequeue. Use the policy's advisory output only inside a transaction that validates eligibility and capacity again.
3. Provider adapter interface: `search`, `submit`, `poll`, `cancel`, `cleanup`, `capabilities`, `inspectActive`. Preserve existing validation and approved-import pathways, and pass explicit `downloadClient` to Usenet operations.
4. Short Honker phase messages may carry claim IDs; release capacity on terminal state or after confirmed cleanup. Never run parallel attempts on the same logical track.
5. Ensure cancellation revokes the claim/generation before external cancellation; before import, validate it again under the correct lock. Prevent a stale attempt from committing after reassignment. Keep confirmed imported files during Force Clear.
6. Persist failure codes, provider history and bounded attempts. Rate limits/outages trigger cooldown, missing/invalid content triggers fallback, and explicit cancellation never triggers fallback.
7. Handle album groups with one leader/reservation and member IDs; when partial media is verified, settle only matching members and keep unmatched members wanted.
8. Implement UI controls for client limits, active slots, failure history and track/album job controls. Add API authorization checks.
9. Add deterministic SQLite concurrency tests, mocked provider telemetry tests, forced crash/restart tests, ownership and album cancellation/import races, per-client Usenet integration, frontend tests and UI build before activation.

## Recovery / migration / rollback

**No migration is needed for Increment 1.** Legacy queue remains authoritative. On later activation, add schema non-destructively, drain/quiesce the legacy queue, snapshot persisted job/attempt IDs, reconcile external transfers, then enable the dispatcher under a feature flag. Never duplicate a live transfer while migrating. Rollback requires disabling new dispatch, revoking scheduler leases, reconciling outstanding external transfers with legacy statuses and restoring the previous workers; do not blindly replay already imported tracks.

## Deployment status

This branch is development-only; CT118 is unchanged. Do not deploy this increment as the full scheduler. It neither removes the shared bottleneck nor implements durable slot claims, full job controls or crash recovery yet.
