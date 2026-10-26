# CT109: Restore the proven Apple POC comparison workflow

Follow-up to the connected-library/taste patch on Aurral 2.11 CT109. The user's screenshot confirms the preceding patch is installed and the live Apple library request works. This update brings forward the actual Scan & Compare, track comparison, owner-scoped inventory and selected missing-track restoration from the proven Apple POC (`work` branch), using the working browser Connector session in place of the temporary Windows bridge. It does not restore the old viewer or require another login.

## Use

Profile → Apple Music → **Scan & Compare**. It lists personal playlists and recommendation playlists, identifies existing imports, and sequentially compares imported playlists with the current signed-in user's Aurral copies. Existing imports are identified first by saved Apple source identity, with normalized name matching for older Apple POC imports. A name match is explicitly not presented as a completed track comparison.

Open a playlist to see exact matches, possible matches, missing tracks, ambiguous tracks needing review and local additions. Artist/title/album comparison preserves the POC's conservative distinction: possible or ambiguous matches are never offered for automatic restore. A repeated remote occurrence of an already consumed local track is marked for review rather than missing. No comparison queues downloads, changes tracks, or removes local additions.

**Use for my recommendations** saves the playlist artists as taste signals for the signed-in Aurral account. It does not copy Apple's recommendation algorithm, create an Aurral playlist or download tracks. Saved taste remains separate from import/comparison and survives discovery resets, as in the preceding patch.

For an existing import, **Import selected missing tracks** accepts 1–50 explicitly selected missing tracks after confirmation. The server fetches the complete source again, checks its fingerprint and current owner/membership, and queues only verified missing tracks through the existing append operation. Stale, ambiguous, already-present, possible-match, duplicate and other-user selections are rejected. The append operation also checks the supplied owner when executing queued connector work. New full imports remain separate and duplicate Add is disabled for identified existing playlists.

**Use Apple cover for this Aurral playlist** explicitly replaces that existing playlist's current cover after confirmation. The server fetches Apple's source metadata again, validates the owned match and unchanged source, downloads only the verified bounded Apple playlist image, checks ownership/session again and uses Aurral's existing image upload/normalization path. No music or preference snapshot is changed. A track-artwork fallback is labeled and cannot be applied by this playlist-cover action. This is an intentional replacement; artwork is not silently changed during scanning or recommendation seeding.

## Metadata and limits

The POC's localized `name`/`title` fallback is restored for playlists and track titles. If Apple still provides neither, the list shows a distinct unnamed entry with its ID. An unnamed source cannot be matched to an old import by a generic label or added as an unidentified new duplicate. This addresses a concrete difference from the POC; the user's actual missing-name response still needs live verification.

The scan limits discovery to 20 recommendation groups and comparison to 50 identified imported playlists, with progress and a stop-after-current-request control. Larger scans explicitly report their limits; other playlists can be opened individually. Requests remain sequential. A failed library/group/comparison request remains unverified; available personal playlists can still be compared when recommendations fail. Existing Connector read/session/page/track/image/time limits remain in place.

Existing source IDs allow renamed imports to be found. Legacy imports lack those IDs and still rely on name matching; multiple matches require review. Scanning neither backfills legacy source IDs nor synchronizes Apple playlists automatically. It compares playlist membership, not every physical file in /music.

## Installation

`python3 apply-patch.py --check` checks expected versions without changes. `--install` verifies six source files and frontend payload, stops Aurral, saves a private source/frontend/SQLite backup, installs the update and leaves Aurral stopped. `--enable` verifies installed code and application health and resumes normal startup recovery. Existing Connector pairing/session and taste settings are preserved. No browser extension update, new dependency, path configuration, scheduler tuning or schema migration is needed.

`--rollback` restores the previous code/frontend and removes the new comparison module. It preserves the current database and completed work, including playlists/tracks already restored. It does not revert cover replacements the user explicitly made after installation. The service remains stopped; review output before `systemctl start aurral.service`.

## Validation

Pure POC comparison tests cover exact/possible/missing/ambiguous/local-only counts, duplicates, source identity precedence and fingerprints. Eight route tests cover read-only owner isolation, unchanged-source checks, explicit acquisition/replacement consent, stale selections, current membership changes, ambiguous legacy imports and no incidental downloads. Worker tests verify repeat imports and ownership changes before append. Connector and playlist regressions passed. Frontend/backend lint and build passed.

Actual Chromium fixtures verified Scan & Compare against an existing import, no downloads on comparison/taste/artwork actions, disabling duplicate Add, explicit cover replacement, restoring only the checked missing track, and continuing personal comparison when recommendation requests fail. Prior connector lifecycle/taste UI checks also passed. The installer has 17 passing tests; an actual six-file/frontend mocked-service install/enable/rollback preserved pairings, taste and newly completed database work and restored the original source/UI. Tests/build ran with a 2-CPU, 3-GiB aggregate RSS guard.

All account API tests use fixtures. Live Apple session/library access was already confirmed by the user; the new comparison/artwork controls require live confirmation after this update is installed.
