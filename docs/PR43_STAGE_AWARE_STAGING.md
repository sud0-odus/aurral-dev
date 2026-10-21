# PR43 stage-aware pipeline staging notes

This branch is a **draft** and must not be deployed to CT120 until CI, isolated transfer tests, and merge-base checks pass. Its base includes PR40 and an explicit merge parent for PR38 source-audio preservation.

## Stage ownership and capacity
- One durable job/attempt retains ownership across search, download, poll, and finalize.
- Search and transfer reservations have independent capacity accounting; finalize is separate.
- On a successfully enqueued stage handoff, the previous stage stops consuming provider capacity.
- A remote slskd/Usenet transfer retains its transfer reservation during polling.
- With AURRAL_PROVIDER_SCHEDULER=1, yt-dlp acquisition slots use integrations.ytdlp.maxActive (up to 8) rather than AURRAL_YTDLP_PIPELINE_LIMIT=2.

## Deadlines
- yt-dlp search: maximum 60 seconds for its search phase; cancellation is propagated to yt-dlp subprocesses.
- slskd search: 60-second deadline persisted in the durable payload across search polls.
- yt-dlp transfer: no reported progress for 300 seconds triggers cancellation of process group.
- slskd remote transfer: 300 seconds without progress triggers cleanup and candidate/source fallback.
- No automatically timed-out operation may be counted as successful completion.

## Frontend
- Restores PR20 collapsed-by-default Tasks queue status sections in the source component.
- Frontend build must be performed from this branch or a verified combined tree; do not copy a stale frontend/dist into staging.

## Explicit remaining validation
- Prove real five-lane yt-dlp acquisition with the fake subprocess test and real slskd polling under capacity; inspect CI.
- Validate restart recovery, attempt-ID mismatches, stale remote work, and cancellation races.
- Measure before/after tracks per minute, CPU seconds per track, API p95, and click-to-first-audio p95 on CT120.
- Never modify /opt/aurral-3-source or CT120 production during initial code review.
