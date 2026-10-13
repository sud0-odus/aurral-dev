# Home-lab Aurral development handoff

Updated: 2026-10-13. Home-first development notes for branch `dev/youtube-source-matching` in `sud0-odus/aurral-dev`.

## Priorities and scope

1. **Home-first:** Make Aurral work well for our household. Upstream contribution is optional; selectively review upstream improvements and periodically sync only when appropriate.
2. **Current top priority:** Improve **music acquisition** (yt-dlp search/selection/verification/fallback and Lidarr/Prowlarr indexer usefulness), then ensure successfully acquired audio and playlists are visible and playable in MiniDisc.
3. **Deferred:** Automatic missing-track reconciliation, recipient-owned copies/Respectful Sync, additional music-discovery integrations. Do not spend work on these unless priority changes.
4. **No production changes:** CT116 is production and out of scope. Changes/tests belong on development CT118.

## Environment (no secrets)

- Proxmox N100S: `192.168.1.141`; development CT118 `192.168.1.109`, app `/opt/aurral-dev`, service `aurral`, web `http://192.168.1.109:3001`, SQLite `/opt/aurral_data/aurral.db`.
- Lidarr CT103: `192.168.1.32:8686`. Do not include API keys, app session tokens or Apple bridge certificates in commits/logs.
- Last integrated Apple Music + playlist sharing checkpoint: `520c1a71` (`Add Apple Music import refinements and playlist sharing`).
- Aurral offers Subsonic/OpenSubsonic endpoints directly; MiniDisc iOS connected and successfully displayed playlists, streamed music, artwork and lyrics, and connected to Lidarr. No Navidrome needed for this test.

## Latest confirmed Apple Music playlist test — deferred

Ms.Rachel playlist `ce9ca7a7-c885-4a70-80ef-d046f2ddeca1`:
- 23 playlist tracks.
- 23 playlist-owned download jobs and 23 metadata-matched jobs.
- 2 completed; 21 failed; zero entries without matching jobs.
- The playlist's 23 stored track entries had **no** `canonicalJobId` / `jobId`; jobs nevertheless existed and could be matched by artist/title.
- Interpretation: not a missing-job issue. Improving acquisition is higher priority; do not start an ID backfill/reconciliation patch solely from these counts.
- Verified on CT118 with read-only SQLite queries. No code or data modifications.

## Acquisition next steps

- Audit actual CT118 source configuration, priority/fallback, yt-dlp search-result quality, verification errors, and recent outcomes in **one sanitized, read-only diagnostic**, rather than a series of redundant commands.
- Lidarr/MiniDisc test: Maluma `Don Juan` search did not yield usable results. Internet Archive indexer returned poorly named entries rejected as unparseable; PandaCD returned no usable results. This is not evidence that Lidarr itself or MiniDisc is broken. Evaluate search/match quality and usable indexer coverage separately.
- Existing code has `backend/services/downloadPipeline.js`, `ytdlpOrchestrator.js`, `downloadSourceService.js`, and Subsonic endpoints `backend/routes/subsonic.js`. Favor targeted fixes to this pipeline over a separate importer.
- Validate acquisition success -> library visibility -> MiniDisc playlist playback before considering CT118 for production promotion.

## External references and V3 preparation

- Upstream feature issue #22: https://github.com/lklynet/aurral/issues/22 ; exploratory Apple Music comment posted at https://github.com/lklynet/aurral/issues/22#issuecomment-6138266161 . Do not wait for upstream approval to continue home improvements.
- Treyzer567 shared `app.py`, `lidarr_helper.py`, `playlist_updater.py`, `requirements.txt`, `playlist-tool.html` in #22. Supports Spotify/YouTube Music imports; Apple Music marked coming soon. Matcher uses title/artist/album similarity; unmatched tracks are sent to Lidarr/Deemix and a short-lived Jellyfin polling updater. Do **not** deploy as-is: its initial importer deletes/recreates an existing playlist, artist monitoring can request broad album searches, and polling state is discarded after its finite window. Borrow ideas selectively.
- Upstream V3 branch: https://github.com/lklynet/aurral/tree/lklynet/aurral-3 . Its static playlist jobs are Library-owned and referenced via `jobId`. The schema-5 migration has readiness requirements and is not backward compatible with V2 DB. Review selectively, **do not merge or migrate CT118 blindly**. Design refs: `docs/architecture/0005-aurral-3-upgrade.md`, `0006-static-playlist-download-jobs.md`.

## Development workflow — mandatory

- **GitHub first, CLI only when local:** Personally inspect upstream `lklynet/aurral` and fork `sud0-odus/aurral-dev` via GitHub access. Never ask the user to run terminal commands merely to retrieve public source, diffs, commits, or tests already accessible.
- Ask for N100S/CT118 commands only for inaccessible local runtime, logs, DB or applying/testing changes.
- **One actionable step per turn.** When patching, deliver a real verified patch/applicator, exact Windows-to-N100S transfer and CT118 apply/test commands; don't invent patches/links or require unnecessary manual copy/paste.
- For requested terminal output, emit `===COPY FROM HERE===` and `===TO HERE===` markers. Prefer one consolidated scoped diagnostic over repeated commands; never print secrets. Use green N100S instructions; default text for N100P.
- Avoid production CT116. Keep secrets, certs, keys and local backup files out of Git. Do not claim a commit, successful test, upload or deletion without result evidence.
- Prioritize straightforward home-lab risk management; report exactly what tests prove, not speculative catastrophes.

## Windows Downloads cleanup

User wants to clean Windows Downloads **after** handoff update. This repo update does not access the Windows filesystem. Collect a targeted, read-only inventory of Aurral patches, scripts and temporary artifacts in `%USERPROFILE%\Downloads` before suggesting any deletion. Preserve unique files and unrelated downloads; only delete explicitly confirmed redundant staging artifacts.
