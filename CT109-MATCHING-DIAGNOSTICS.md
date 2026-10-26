# CT109 bounded Soulseek matching evidence

This is an evidence-capture update, not a matcher/concurrency fix. The user requested repeatable evidence suitable for reviewed GitHub examples, rather than repeated manual snapshots after rejected files were deleted.

## What is captured

Before Soulseek cleans up a rejected file, capture the current stored playlist reference, queued job reference, effective validation reference, and original embedded artist/title/album-artist and MusicBrainz tags. Keep the normalized observed recording claim separately from the original tag fields. Store duration/recording/alias differences, matcher policy/decision/evidence/contradictions and basename-only advertised filenames. Stored-playlist metadata is its CURRENT value; it is not asserted to be an immutable original Apple API response. Source track IDs are retained locally when available.

For searches ending with no usable candidate, store raw/evaluated/eligible/query counts, decision and rejection-reason counts, and up to three ranked examples. This helps distinguish no search hits, provider filtering, identity rejection and quality/denied-source filtering. It does not capture every raw result or peer response. Every rejection is eligible for capture; a deterministic5% verified sample gives comparison examples. No audio is retained by this feature.

Evidence goes only into the local `matching_diagnostics_v1` SQLite table. No new public API is added, and it is not exposed by normal settings/status routes. No GitHub or other remote upload occurs. Existing file cleanup, acceptance/rejection decisions, retries, source priorities and worker counts are unchanged.

## Bounds and failure behavior

At most1,000 records, at most8,192bytes of JSON per record (under8MiB total payload, plus SQLite/index/WAL overhead). Overlong text/alias lists are clipped; oversized records are reduced and marked truncated, or skipped if they still exceed the bound. Old records are pruned after7days on the next capture. There is no additional cleaner or polling worker.

Capture is synchronous, local, best effort. SQLite busy timeout is temporarilyzero during capture and restored afterward; database contention/errors skip evidence rather than holding up matching. Capture failure emits at most one static warning per30minutes per process. These are bounded diagnostic samples, not a complete lifetime event ledger or a valid success-rate denominator. `AURRAL_MATCHING_DIAGNOSTICS=0` disables capture when provided in the service environment.

Only explicit fields are copied. Full paths, peer names, user/account names, cookies, API keys, complete settings and arbitrary provider response bodies are not stored. Music metadata stays private locally; the export defaults to replacing artist/title/album/filename/source-track-ID values with consistent labels within that export. MusicBrainz UUIDs, durations, scores and policy decisions remain useful structural evidence.

## Export for investigation / GitHub

Run inside CT109:

```
python3 /opt/aurral/scripts/export-matching-diagnostics.py
```

It prints a timestamped `.json.gz` path under `/tmp`. The exporter opens the existing database read-only/file-must-exist, reads at most1,000 records and creates a private0600 file without overwriting existing reports. Default window24hours; `--hours` supports up to168hours. Use `--db` for a different installation path.

For exact musical examples in a private support upload or a deliberately reviewed GitHub issue:

```
python3 /opt/aurral/scripts/export-matching-diagnostics.py --include-track-names
```

That retains song/artist/album/basename/source-track-ID values. Review the export before public posting: listening preferences can be identifiable even without credentials. Case examples can then become reproducible regression fixtures. Do not automatically push the production database or rolling diagnostics into GitHub. The application does not continuously deliver reports to this chat; automatic delivery would be a separate explicitly configured integration.

## Why this evidence is needed

The overnight report showed37 of47 unsuccessful searches had results and19 of25 post-download failure/review entries involved artists. Rejected media had already been deleted, so aggregate history could not establish actual embedded identities.

One observed pattern was a request expecting3:33.6, a different remix of that length rejected by title, and the requested-looking remix of2:39 rejected by duration. This may be reference misassignment, not a reason to relax matching. A synthetic collaboration-credit fixture became matched when a trusted full collaboration alias was supplied; it did not establish the actual rejected file's tags.

The affected playlist examples are marked`apple-playlist`; the old POC's dropped duration/IDs cannot alone be assumed to explain them. The new log is designed to show stored→queued→effective reference changes alongside original file evidence. Do not hardcode artist aliases, ignore valid recording-ID conflicts or loosen duration/remix checks based solely on filenames.

## Installation and rollback

Four source/script files, no frontend rebuild or browser extension change. Two existing input hashes match the published source-admission and duration/library-boundary pipeline releases. `--check` verifies compatibility without stopping services. `--install` checks free backup space BEFORE stopping Aurral, backs up the small original code files, installs the guarded payload and leaves Aurral stopped. `--enable` verifies code and health before resuming normal startup recovery.

**This patch does not create another full database snapshot.** Its additive diagnostic table is created lazily on first capture. Code rollback restores prior source, removes the two new files, and preserves current database work and diagnostic records. It leaves Aurral stopped; review output before starting the previous version.

## Validation

Six capture tests: original tags, stored/queued/effective differences, privacy allowlist, bounded search samples,1,000-record/age/byte limits, deterministic verified sampling, disabling, write-failure behavior and busy-timeout restoration. Four read-only export tests cover default redaction/correlation, explicit names, file permissions/no overwrite, time filtering and refusing to create a missing database. Matching/Soulseek regression fixtures passed under a2CPU/3GiB resource guard (about155MiB peak for that run). Backend lint passed.

Nineteen installer tests include source-only backups and insufficient-space rejection before stopping. An actual-payload mocked-service install/enable/rollback smoke test verifies no database snapshot and preservation of new completions/evidence. No live CT109 installation or new production evidence capture is confirmed yet.
