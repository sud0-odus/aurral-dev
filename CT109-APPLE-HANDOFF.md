# CT109 Apple Music integration: resume here

## User-confirmed facts — do not repeat discovery

The prior Apple Music POC worked for multiple users. Both spouses imported their playlists successfully through the earlier development/v3 instance, and those playlists are present in current v2.11 CT109. Import correctness and multi-user feasibility are established by the user's actual tests.

The next test is specifically the **Connect Apple Music hosted-browser authentication and cleanup**, not whether playlist importing works. The user prefers an OS-independent popup from Aurral, with no Windows helper, no manual token copying and no continuously running browser. Place the Apple Music section between Connected accounts and Plex account in the individual Profile.

Do not restore the abandoned dev/v3 application wholesale. Port the necessary integration into the clean v2.11 patch stack. Do not repeat broad profiling or ask the user to stay up for interactive testing. No Apple feature has been installed or implemented in this session.

## Current deployment and acquisition work

CT109 is the target: Proxmox, two CPUs, 4 GiB RAM; native app /opt/aurral, DB /opt/aurral_data/aurral.db, service aurral. Browser should run as a separate, explicitly bounded on-demand service; deployment location is not yet selected or provisioned. Do not install a browser directly onto the Proxmox host.

Latest delivered source-lane kit (patch 6), immutable commit:
`b5baa8373d5bd7b66fdd77b5ca1e4dbebbe3f2ac`
`aurral-ct109-source-lanes-patch.zip`
SHA256: `75be7b4978d28a0345d45da4200326b12d0e66b3fe0d6d7cae1748e5735a40bc`

Public URL:
https://raw.githubusercontent.com/sud0-odus/aurral-dev/b5baa8373d5bd7b66fdd77b5ca1e4dbebbe3f2ac/aurral-ct109-source-lanes-patch.zip

This kit was built, published and its public download verified. Installation instructions and detached eight-hour profiler were delivered, but the user has NOT confirmed installing/enabling patch 6 or starting that profile. Do not claim CT109 has it. Existing library-boundary UI was observed in user output (patch 5).

Cloud source: /workspace/aurral-dev on perf/download-pipeline-v2.11.0. Existing patch 1–6 source/test changes remain uncommitted in the working tree. Preserve them. All previous kits and test logs remain under /workspace and /tmp. Source-lane kit: /workspace/ct109-source-lanes. Production source is also preserved in published kit payloads. Broad 903 tests passed; later targeted 82/60/10 tests overlap, 34 Python kit tests passed, actual payload install/enable/rollback smoke passed. No remote production execution was possible from cloud.

## Proven POC source

Repository: sud0-odus/aurral-dev, branch dev/youtube-source-matching (also local `work`).
Checkpoint: `520c1a7198e27684931446dcd8fcb87878e5a0b7` (Apple import refinements/sharing).
Earlier relevant commits: 3b97263b, 7e7f543d, 3ebeb3ab, 6e44cc9c, 6fb3ae8a, 04b38cf1, 95fb9c65.

Read these with git show; do not checkout over the v2.11 working tree:
- apple-poc/aurral-apple-poc.py
- apple-poc/aurral-apple-poc.service
- backend/routes/playlists/handlers/appleMusicPoc.js
- frontend/src/pages/Settings/components/AppleMusicPocModal.jsx
- backend/routes/playlists/handlers/staticPlaylists.js

Existing bridge ties sessions to backend-authenticated `X-Aurral-User-Id`, accepts only loopback callers, stores temporary headers in memory per user, expires them after an hour and clears them on disconnect. Recommendations, personal library playlists, paging, duplicate-name lookup, track comparison and selective missing restoration were implemented. Reuse these working behaviors.

Cleanup/refinement findings:
- Bridge normalizes playlist/track data and drops artwork; import payload also drops Apple playlist identifiers and original artwork.
- Old bridge contains deployment-specific loopback port, certificate paths and legacy app addresses. Make service location/configuration explicit when porting; do not copy these assumptions into CT109.
- Preserve pagination/incomplete-import safeguards and user ownership.
- Existing duplicate lookup is name-based; retaining source IDs would permit stronger matching for future imports. Existing playlists need a reviewed matching/backfill procedure, not blind reimport.

## Identified Apple MCP implementation

Confirmed from PyPI metadata, not guessed:
https://github.com/epheterson/applemusic-mcp
Python package applemusic-mcp; inspected current release 0.21.0 without installing it in cloud.

User Windows installation:
`%APPDATA%\Python\Python312\Scripts\applemusic-mcp.exe`
Commands login, status, serve. Python function `from applemusic_mcp.server import get_headers`.
User status confirmed: User token present; API ok (web session), no paid developer token used. Do not request tokens in chat.

Inspected package source: /tmp/applemusic-mcp-source-review/applemusic_mcp.
Browser engine uses Playwright persistent Chrome context with headless=False. It is already cross-platform, but interactive hosted Linux sign-in has NOT been verified. Need virtual display + browser viewing/control and authenticated popup/session orchestration. Opening an ordinary client-side Apple popup alone does not give Aurral access to its credentials; Plex uses a different provider authorization mechanism. Reuse Plex's UX, not an assumed interchangeable authentication API.

## Artwork evidence

User uploaded apple-artwork-check.json from a bounded authenticated read-only Windows check: 14 personal playlists, no further page; 8 list entries have artwork URLs. All first three playlist detail samples have covers; all 15 sampled track entries have artwork. Six other list entries lack covers; their detail endpoints were not sampled, so don't claim artwork is unavailable. Report contains private user playlist names; do not publish it.

Private local file:
/workspace/attachments/e536b166-8e44-433c-a8c5-ed12db256d16/apple-artwork-check.json

Deezer importer already obtains picture_xl/picture_big but import flow drops artwork. User wants original covers for both providers; keep manual custom covers highest precedence, provider covers next, track-album collage fallback. No cover patch implemented yet.

## Personal recommendations requirement

Main product goal is independent per-user taste without requiring prior scrobbling knowledge/history. Imported interests must be useful without downloading the entire source collection. Separate metadata/taste imports from optional playlist acquisition.

Current v2.11 discovery has per-user caches/history/feedback, but collectUserSeeds in backend/services/discovery/provider.js always mixes in shared-library artists. selectDiscoverySeeds in recommendationPipeline.js allocates library capacity even with some history. Thus users can see recommendations influenced heavily by the household/admin-imported collection; code does not literally assign the admin account as their identity.

Need durable user-owned imported taste/source records separate from disposable recommendation caches. Personal signals should drive recommendations; household library seeding should be explicit. Preserve existing manual preferences/listening history. Saved music, curated recommendations and actual listening are distinct evidence; do not fabricate plays.

Verified reset paths:
- Scheduled refresh rebuilds recommendation caches.
- /discover/clear-discovery clears global and user caches.
- /discover/feedback/reset removes current user's More/Less feedback, retaining blocked artists.
Imported source interests should survive refresh/cache clearing and the existing manual-feedback reset. Removing/resetting imported interests requires an explicit separate action. User A's import/reset/disconnect must not change user B's interests.

## Resume scope

1. Reuse proven POC; build/test the on-demand hosted-browser Connect Apple Music flow, keyed to the initiating authenticated Aurral user. Close browser on success/cancel/failure/timeout; cap concurrent sessions and resources; no credential output.
2. Keep authentication-session expiry separate from durable imported tastes/artwork. Successful login is not yet a completed taste import.
3. Integrate Profile UI at the agreed placement and retain proven import features, adding source IDs/artwork.
4. Connect user-owned taste inputs to recommendation rebuilding with reset/refresh/restart and cross-user isolation tests.
5. Reuse existing public YouTube/YouTube Music playlist and Spotify OAuth importers for the same taste system later. Private YouTube likes/mixes need separate authenticated access. Do not describe all Spotify metadata access as a simple paywall; verify exact app/account eligibility when that work is reached.

No new production changes, browser deployment, or Apple connection work was completed during this review. Next session should resume implementation at authentication orchestration, not ask the user to demonstrate the old importer again.
