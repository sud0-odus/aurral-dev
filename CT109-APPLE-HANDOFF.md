# Resume Apple Music integration here — October 25

## Current outcome

The hosted Connect Apple Music preview is implemented and packaged. It is not yet installed on CT109 and live Apple acceptance in the hosted Linux browser remains unverified. The old POC's actual multi-user importing already works; do not repeat that investigation.

The user prefers installation **inside CT109**, not a required second container. The earlier separate-container proposal was a resource recommendation, not a requirement, and was corrected. The default deploy.py installs both service and profile UI into CT109. Optional --browser-ct supports a separate Debian CT.

Release: aurral-apple-connect-preview.zip on the artifacts/aurral-baseline branch of sud0-odus/aurral-dev. The ZIP contains all source, prebuilt frontend, checksums, root deployer, service installer, application installer, rollback, tests and instructions. See README.md and VALIDATION.md in that release.

Cloud paths:
- /workspace/apple-connect-release (assembled release)
- /workspace/apple-browser-kit (browser service source and tests)
- /workspace/ct109-apple-connect (guarded app installer and payload)
- /workspace/aurral-dev (current v2.11 source, all earlier patch source changes preserved)

The user has authorized this work; there is no need to ask for approval again to prepare/fix the implementation. Production execution still requires their Proxmox console; no cloud-to-N100S session is available.

## Implemented flow and limits

Profile section between Connected accounts and Plex account. Connect opens same-origin popup displaying remote screenshots, forwards pointer/keyboard/paste/scroll input through authenticated Aurral endpoints to an on-demand headed Chromium/Xvfb session. Masked native text input also supports touch/paste. These are server-rendered browser pixels, not a client-side Apple iframe or an assumed Apple OAuth handoff.

POST /api/users/me/apple-music/connect binds the attempt to req.user.id. User IDs supplied in bodies are ignored. No Apple cookies/tokens, browser service key or Aurral token is placed in the popup. Captured headers stay in service RAM, separated by Aurral user, for up to one hour. Closing/canceling an in-flight popup cancels its capture; older cancellation cannot remove a newer connection.

The service verifies a personal-library GET before claiming connection, then closes Chromium/Playwright/Xvfb and removes its temporary browser profile. It reports connected only after cleanup. It supports a read-only complete personal-playlist inventory with source IDs and original artwork metadata. No imports, download jobs or discovery changes are performed by this preview.

Runtime service: aurral-apple-browser.service, dedicated non-root user. Default bind 127.0.0.1:3334; HTTPS with privately paired CA/service key. MemoryMax=1024M, CPUQuota=50%, MemorySwapMax=0, one active browser. Refuses a start below 1.25 GiB CT headroom (including reclaimable inactive file cache). Ten-minute sign-in deadline; 90-second abandoned-client timeout; 15-second cleanup watchdog can kill its own driver/browser tree. Systemd kills its entire cgroup on service stop/OOM.

No Windows helper is needed. One-time administrator pairing is automatic; do not ask users to copy Apple tokens. It does not install Chromium on the Proxmox host.

## Deployment

On Proxmox N100S, download/extract the release under /root/aurral-apple-connect-preview, then:

python3 /root/aurral-apple-connect-preview/deploy.py --check
python3 /root/aurral-apple-connect-preview/deploy.py --install

No CT number/IP is needed for the default shared-CT109 deployment. The check stages /tmp payloads, checks Debian/resources and exact source compatibility. Install adds dependencies/service while Aurral stays running, pairs it privately over loopback, then pauses Aurral only for backup and guarded code/UI install. Existing queue rows/settings are not reset; health/matcher verification gates resume.

The application patch is compatible with current patch-5 or patch-6 acquisition source. It changes users.js and SettingsAccountTab.jsx, adds the Node client, user routes and frontend section, and guards the installed Library boundary module. It does not overwrite acquisition files. Rollback restores old app source/UI, retains current database work and stops the browser service. Packages/private pairing configuration are kept but inactive.

Read /root/aurral-apple-deploy.log for installer failures. Browser journal prints only lifecycle/error class, not input/headers/raw responses. Do not publish runtime credentials or users' Apple inventory reports.

## Verification already completed

15 Python browser lifecycle/isolation/admission tests; 9 Node API/TLS tests; 56 auth/history/acquisition regressions (overlap); 21 application-installer/pairing tests; 4 deployment-target validation tests. Actual source/frontend payload install/enable/rollback exercised against a temporary application with mocked service/health; post-patch database work preserved. Frontend build and scoped lint passed. Real Chromium remote input/screenshots/temp-profile cleanup passed in cloud headless mode. UI fixture exercised open/input/success/close/cancel/disconnect/metadata and showed zero page errors. These do not establish successful Apple sign-in on CT109.

Do not claim Proxmox package/service installation or actual headed Linux Apple sign-in is verified before the user's live test. If it fails, investigate this new session capture/viewer/cleanup boundary, not whether the proven Apple playlist API import exists.

## User goals and subsequent work

The main product goal is per-user discovery seeded by existing streaming-service interests without requiring prior scrobbling. Old Apple importer already worked for both spouses; many existing wife-owned playlists were imported from Apple through the retired development/v3 setup and carried into v2.11.

After verifying the new popup: port the proven import UX and user-owned source IDs/artwork; add durable per-user imported taste records; wire discovery to these records. Imported interests must survive scheduled refresh, cache clearing and the existing More/Less-feedback reset; removal requires a separate explicit action. Metadata-only preference import must not trigger music acquisition. Do not fabricate play history from playlists. Household library taste sampling should be explicit.

Current v2.11 collectUserSeeds always samples shared-library artists alongside per-user history/feedback. This causes household/admin collection influence; it is not literal admin-account impersonation. Per-user caches alone do not fix the input problem.

Known POC source checkpoint: 520c1a7198e27684931446dcd8fcb87878e5a0b7, local work / origin/dev/youtube-source-matching. Relevant source: apple-poc/aurral-apple-poc.py, backend/routes/playlists/handlers/appleMusicPoc.js, frontend/src/pages/Settings/components/AppleMusicPocModal.jsx. Proven bridge uses loopback authenticated backend identity, per-user in-memory headers with one-hour TTL, paging, duplicate checks, track comparison and selective missing restore. Its normalization/import payloads drop artwork/source identifiers; retain/fix these when porting. Do not restore the old dev/v3 application wholesale.

Apple MCP is https://github.com/epheterson/applemusic-mcp (PyPI applemusic-mcp; inspected 0.21.0). Windows get_headers/status session worked without paid developer token. The hosted bridge follows web-player Authorization and media-user-token capture and validates them against amp-api.music.apple.com. It needs actual Apple acceptance tested in the new browser.

Artwork report privately showed 14 personal playlists, 8 with covers in list responses; first 3 detailed playlists had covers and all 15 sampled tracks had artwork. Six other list entries lacked artwork; their details were not sampled. Do not declare their covers unavailable. Deezer importer already reads picture_xl/picture_big but drops it during import. Cover priority: preserve manual images, source originals next, album collage fallback. No original-cover/backfill patch delivered yet.

Other providers later: existing public YouTube/YouTube Music playlist import and Spotify authorization/import should feed the same personal taste model. Private YouTube likes/mixes need authenticated access. Avoid blanket claims that Spotify metadata access is behind a paywall.

Prior acquisition patch 6 ZIP was published at b5baa8373d5bd7b66fdd77b5ca1e4dbebbe3f2ac but user has not confirmed installing/enabling or running its overnight profile. Do not assume that production state. Preserve all prior v2.11 patch work.
