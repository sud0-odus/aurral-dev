# Remove the custom Apple screenshot/input viewer

This retires the hosted screenshot/input viewer instead of replacing it with
another remote desktop. Supports either the initial Apple preview UI or the
streaming-viewer follow-up, and the three published helper versions.

Run inside CT109:
```
python3 apply-removal.py --install
```

Both installed application and helper versions are checked before service
changes. Aurral stops briefly for a local source/UI/current-DB backup. The patch
removes the Apple viewer UI, its proxy routes and browser client, then enables
Aurral and checks health/matcher availability. It stops/disables the dedicated
Apple helper and archives its files, unit, pairing and dedicated home privately
under /opt/aurral-patch-backups. The old helper can take up to 65 seconds to stop.
Chromium/Xvfb packages remain installed to avoid removing shared dependencies.

Imported playlists, current DB work, discovery data, download scheduler and Plex
code are preserved. Ctrl+F5 after success. No replacement Apple login flow is
claimed or installed by this removal.

If anything fails, share the output; do not bypass input hashes or repeat the
whole launcher after a partial install. The components can be resumed separately.

Rollback if needed:
```
python3 remove-helper.py --rollback
python3 app/apply-patch.py --rollback
systemctl start aurral.service
```
The helper returns to its previous active/enabled state. Its previous viewer is
known to be unsuitable; it may be left stopped independently of Aurral.

## Plex review and Apple session findings

PlexSelfLinkSection.handleConnect requests a temporary PIN/client identifier,
opens https://app.plex.tv/auth in the user's real browser, and polls Aurral every
two seconds for approval. The backend polls Plex's PIN endpoint, validates the
resulting token and links the authenticated Aurral user. No hosted browser,
screenshots or forwarded input is used.

The proven Apple MCP/POC web path does not require the user's own Apple Developer
account. Its auth.resolve_web_token fetches Apple's public AMPWebPlay token via
ordinary HTTP requests. browser.capture_user_token reads the media-user-token
from an authenticated browser profile. The two together support browserless
playlist API calls after initial capture. The remaining integration problem is
initial session handoff; MCP does not expose a Plex-equivalent web-session
approval callback. Opening Apple in a normal tab does not let Aurral read that
tab's cookie. The paid MusicKit/developer route is a distinct alternative, not
a prerequisite for the existing working web-session path. A proposed future
handoff must be verified before another login UI is offered.

## Validation

179 offline Plex/authentication/playback tests passed. Resource-guarded test
run: two CPUs, peak sampled RSS 467.3 MiB, elapsed 19.7 seconds.
18 installer checks passed, including deleted-file backup/restore.
Actual five-file removal plus prebuilt UI was installed/enabled/rolled back in
temporary application fixtures for BOTH published UI versions, with fresh-process
rollback and imported-playlist DB preservation. Helper stop/disable/archive/
rollback and unknown-code rejection were tested with mocked systemd. Scoped UI
lint and production frontend build passed (821 MiB sampled build RSS, 4.5 seconds).
These do not assert that removal has been applied to CT109.
