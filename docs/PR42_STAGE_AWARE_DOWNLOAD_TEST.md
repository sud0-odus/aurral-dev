# PR42 CT120 test handoff — stage-aware download pipeline

**Safety:** PR42 is a staging change, not automatically deployed. Production stays on
\`/opt/aurral-pr41-stage\` until an operator deliberately switches the service.
Never reset/clean \`/opt/aurral-3-source\`; that working tree has user modifications.
Do not copy PR41's old \`frontend/dist\` over this PR: rebuild from PR42 source
to preserve the approved PR20 collapsed Tasks queue.

## Intended behavior
- Provider scheduler owns each attempt, but **search, transfer, and finalize**
  independently reserve/release capacity at durable Honker handoffs.
- \`integrations.ytdlp.maxActive=5\` and \`integrations.slskd.maxActive=5\` bound
  active transfers when \`AURRAL_PROVIDER_SCHEDULER=1\`.
- Search concurrency remains separately limited (yt-dlp subprocess
  \`AURRAL_YTDLP_SEARCH_LIMIT\`, default 1); five download lanes do **not**
  mean five metadata searches.
- Searches time out/fallback after 60 seconds; stalled transfers after five
  minutes without bytes/meaningful state change. Remote slskd polling retains
  its transfer slot until termination; finalized jobs free acquisition slots.
- Source-preservation from PR38 stays available/enabled through DB settings.
- A generation+attempt ID and persisted queue-stage sequence avoid old claimed
  messages replaying after a newer stage is durable; yt-dlp recovers a finished
  same-video staging file and slskd reattaches to an existing transfer.

## Safe preflight on host N100S
1. Record current \`systemctl show aurral.service -p WorkingDirectory -p MainPID\`.
2. Confirm Git branch and SHA, no uncommitted modifications in PR42 stage:
   \`git -C /opt/aurral-pr42-stage status --porcelain\`.
3. Verify source-preservation DB setting remains \`true\` and backup active
   service config to \`/root/aurral-pr42-before-switch.conf\`.
4. Run backend syntax checks and focused tests *before* touching systemd:
   \`\`\`sh
   cd /opt/aurral-pr42-stage
   export PATH=/opt/node-v26.10.0/bin:$PATH
   node --check backend/services/downloadPipelineWorker.js
   node --check backend/services/downloadJobs/providerSchedulerRuntime.js
   node --check backend/services/downloadJobs/pipelineDiagnostics.js
   node --check backend/services/ytdlpClient.js
   node --check backend/services/slskdOrchestrator.js
   node --test --import ./.tests/setup-env.js \
     .tests/download/pipeline-capacity-stages.test.js \
     .tests/download/pipeline-sequence-policy.test.js \
     .tests/download/provider-five-lanes.test.js \
     .tests/download/ytdlp-progress.test.js \
     .tests/download/ytdlp-search-slots.test.js \
     .tests/download/audio-bitrate-fallback.test.js
   npm run build --workspace frontend
   \`\`\`
5. Confirm \`frontend/dist/index.html\` exists and Tasks page source uses
   \`QueueSections\` with \`expanded={}\` initial state, not \`QueueTable\`
   alone. Compare any additional local UI changes before replacing builds.
6. Only switch the service if tests and build pass; leave PR41 rollback intact.

## 10-minute workload test after explicit operator deployment

Optional diagnostics enabled via separate systemd \`Environment=\` values:
\`AURRAL_DIAG_PIPELINE_TRACE=1\`, \`AURRAL_DIAG_HTTP_TIMING=1\`.
The diagnostics persist only job IDs and stage names/elapsed times; do not
upload raw song titles, URLs, access tokens, paths, or user-identifying data.
Disable tracing again after the test to reduce database writes.

Record at T0, T+5min and T+10min:
- Completed jobs, failed/blocked jobs, pending messages (read-only SQL).
- Effective reserved **transfer** capacity by provider/stage, and subprocess/
  remote transfer counts; distinguish a lease from an active transfer.
- \`Pipeline trace 60s summary\` in journal: CPU-seconds in downloads worker,
  completed jobs, search/transfer/finalize p95, queue p95, provider active counts.
- \`HTTP timing 60s\` in journal: navigation/API/playback first-byte p95.
- Open the UI with \`?aurralPerf=1\` to observe long tasks and navigation.
  Measure click-to-first-audio separately using browser DevTools.
- Verify 5 concurrent transfers *when five transfer-ready jobs exist*, not
  merely five UI jobs in "downloading".
- Simulate timeout and user cancellation in a **nonproduction test queue**
  where possible. Observe remote cancellation, reservation release, and
  actionable failed/review state.

## Pass/fail rules
- Aurral service starts cleanly and the library/music streams still play.
- PR20 Tasks queue collapsed by default, with detail table preserved.
- No fresh duplicate downloads or stranded reservations after a controlled
  worker restart and attempt cancellation.
- Five actual simultaneous yt-dlp acquisitions and up to five slskd transfers
  when there are five eligible ready jobs and the remote peer supports them.
- CPU-seconds per completed track and p95 API/playback timing improve or do not
  regress materially; **do not** infer throughput from reduced CPU alone.

## Rollback
Restore \`/root/aurral-pr42-before-switch.conf\` to the exact original
systemd override, run \`systemctl daemon-reload\` and \`systemctl restart
aurral.service\`. Validate active working directory is PR41. Do not delete
the new database reservation \`stage\` column; it is backwards-compatible
because old writes omit it and the column defaults to \`search\`.
Never reset download history or remove source library files to roll back.
