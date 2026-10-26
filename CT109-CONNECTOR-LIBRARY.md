# CT109: Connected Apple library and personal recommendation sources

For the existing Aurral 2.11 CT109 installation with the validated Connector streaming follow-up. The user confirmed **Service session validated and connected** before this patch. No extension reinstall, pairing reset, hosted browser or developer membership is needed.

## Behavior

Profile → Aurral Connector → Apple Music now offers personal playlists and Apple recommendation groups. Select a playlist and preview its cover and complete track count.

* **Use for my recommendations** reads the selected source, saves its artist preferences for the signed-in Aurral user, and queues that user's discovery refresh. It creates no music playlist or download jobs. Repeat imports are idempotent; a name/artwork-only change does not rebuild recommendations.
* **Add playlist and queue missing tracks** is a separate explicit action. New playlists retain source identity, artwork, track IDs and durations and use the existing acquisition pipeline. Replays preserve local additions. Matching existing owned Apple POC playlists are returned unchanged rather than duplicated; legacy matching uses exact case-insensitive names and does not backfill their artwork/IDs.
* Saved recommendation sources survive feedback reset, discovery-cache deletion and disconnecting Apple. Removing a source removes only that user's saved preference snapshot.
* Personal recommendations use the user's feedback, listening history and selected imported sources. Shared-library artist sampling and global recommendation fallback no longer stand in for a user's taste. Old personal pools are invalidated and rebuilt. Accounts without personal inputs may have an empty personal recommendation section; global trending remains available.

This is a snapshot import, not automatic Apple synchronization. Recommendation groups expose playlist sources, not a complete export of Apple's listening history. Existing/custom playlist covers are preserved; Apple artwork is fetched for newly imported playlists, with the existing generated fallback on failure.

## Bounds and privacy

Authenticated account identity comes from the Aurral session, never a request user ID. Stored source summaries are per user and contain artist counts, not fabricated listening events. Existing encrypted Apple sessions and browser pairings are unchanged. Public settings/status never expose them.

At most one Apple read per user and two globally, with a 60-second scan deadline (an outstanding bounded request may take up to 15 seconds longer). Pagination is sequential, limited to 40 pages and fixed Apple API paths. Lists cap at 2,000 playlists, 200 groups, 1,000 group entries; a selected playlist caps at 3,000 tracks. Failed or incomplete reads do not save a partial taste source or enqueue a partial playlist. Source artwork allows HTTPS Apple mzstatic image hosts only, no redirects/auth headers, 10 seconds/4 MB. Existing private JSON and public streaming limits remain intact.

## Install and rollback

Run `python3 apply-patch.py --check` inside CT109 to inspect compatibility without changes. `--install` verifies the 16 source-file versions and payload, stops Aurral, saves a private local code/frontend/SQLite backup, and installs prebuilt assets. It leaves the service stopped. `--enable` verifies installed versions and health, then resumes existing eligible work through normal startup recovery.

On unexpected source versions, stop and retain the diagnostic; do not bypass checks. `--rollback` restores the previous sources/frontend, removes new modules and leaves Aurral stopped. It preserves the current database, pairings, saved sources and completed downloads. Resume the old version with `systemctl start aurral.service` after reviewing rollback output.

No schema migration, queue-row rewrite, download scheduler change, extension change, dependency installation or filesystem-path hardcoding is part of this patch.

## Validation

Offline fixture tests cover API pagination, session revocation during reads, ownership, idempotency, source metadata, consent before acquisition, legacy playlist preservation, image limits and keeping custom covers. A real Chromium UI fixture checked preview artwork, saving taste without downloads, explicit acquisition, saved sources after disconnect/reload and removal. Discovery regressions include rebuilding from the imported user's artists after feedback/cache reset while excluding another user's taste and the shared library. Playlist, connector and remaining discovery regression files passed; earlier ListenBrainz fixture expectations were updated to reflect removal of shared-library seeds. Frontend lint/build and backend lint passed.

The installer has 17 passing fixture checks. An actual 16-file/frontend install/enable/rollback smoke test preserved existing pairings, saved taste and newly completed database work and restored the old UI/source. Validation ran under a 2-CPU, 3-GiB RSS guard (frontend build peak about 811 MiB).

Live Apple authorization was confirmed by the user. Apple library browsing with their account and this patch's live CT109 installation remain to be verified after installation; cloud tests use fixtures and do not access their credentials.

Review tests are included for inspection and run in the repository's test harness. They are not copied into the live application.
