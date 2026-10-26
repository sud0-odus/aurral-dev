# Aurral Connector 0.1 preview for CT109

Reusable connector framework with separate installation, account pairing and
service connections. Apple Music is the first adapter; Spotify and other service
adapters are not implemented by this release. The hosted viewer remains removed.

## Install the Aurral side (inside CT109)

```
python3 apply-patch.py --check
python3 apply-patch.py --install
python3 apply-patch.py --enable
```

The guard expects the confirmed viewer-removal build. It backs up current source,
frontend and DB, briefly stops Aurral, adds connector routes/store/UI and enables
Aurral with health/matcher checks. No download scheduler/source matching files or
browser services/packages are installed or changed. New connector module folders
are created as needed. No existing queue rows or playlists are edited.

## Install the browser side once

Hard-refresh Aurral (Ctrl+F5), then Profile > Aurral Connector. Download the ZIP
there to Windows, extract it to a permanent folder, open chrome://extensions or
edge://extensions, enable Developer mode and Load unpacked that folder. The ZIP
must be extracted; select the folder containing manifest.json. Pin the toolbar
icon if useful. A future store listing can replace this preview installation.

## Pair separately

In Aurral choose Pair Aurral Connector, then open the extension toolbar icon while
that Aurral tab is active. Confirm Pair this browser with the displayed server.
No streaming session is captured during installation or pairing. Separate Aurral
users must pair their own accounts; their sessions/status are isolated.

## Connect a service

In Aurral choose Connect Apple Music. Open the connector icon from that Aurral
tab and approve Apple-specific access. Use the intended Apple Music account in
that Chrome/Edge profile. An ordinary Apple tab opens if login is needed. Keep
the Aurral tab open. The connector completes the handoff after the session cookie
appears. Aurral fetches the public web-player token and validates library access
before accepting the session. No paid developer account is required for this web
path. This is session connection/validation only; importing playlists/artwork and
seeding durable per-user discovery are the next stage, not included here.

## Boundaries

- No standalone MCP, local daemon, CT browser or remote screenshot/input viewer.
- Only activeTab/scripting/storage at install. Apple cookie/host access is optional
  and requested explicitly when Apple is connected. No all-site cookie export.
- Device/server/account identifiers are stored by the extension, never captured
  service sessions. Pending handoffs use session storage and expire in five min.
- Delivery uses the authenticated Aurral tab; no public unauthenticated credential
  callback, extension server token, cross-origin API exception or secret URL.
- Requests are one-use, authenticated-user/service-bound, expiry-checked and
  replay-protected. Server rechecks device pairing after provider validation.
- Sessions are encrypted with Aurral's settings encryption key, never returned
  by status. Removing a paired device revokes its stored service sessions.
- New adapters require both a capture adapter and server validator. Their hosts
  must remain optional. Use existing native OAuth flows where appropriate.

## Validation and live checkpoint

18 connector checks cover account isolation, encrypted storage, request expiry /
replay, revocation during validation, service host/credential validation, no capture
from pairing alone, and no session persistence in extension storage. 161 existing
auth/Plex checks pass. Actual React/browser message handoff tests pass pairing,
capture, acknowledgement, replay, changed-origin and cancellation behavior.
The Chrome API transport in that test is a shim: managed Chromium here blocks
unpacked extensions. Extension loading/permission prompts and a real Apple session
have NOT been validated in the cloud. Those are the first local Chrome/Edge check.
Apple's live website is also blocked by the cloud proxy; no live account success
is claimed. Review-tests record cloud fixture code, not production commands.

Scoped lint, production UI build, 17 installer checks and actual seven-file /
prebuilt-frontend fixture install/enable/rollback pass. Current DB work survives
rollback. Do not repeatedly reinstall if a step fails; share the exact result.

## Rollback

```
python3 apply-patch.py --rollback
systemctl start aurral.service
```

The current database is preserved, including encrypted connector data; rollback
removes the new routes/UI rather than restoring an old database. Disconnect a
service/remove a device in Profile to erase its stored session intentionally.
