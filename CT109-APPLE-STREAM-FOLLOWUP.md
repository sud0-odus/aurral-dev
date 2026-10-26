# CT109 Apple browser streaming follow-up

Apple-only follow-up for the installed Apple connect preview plus capture hotfix.
It does not change download scheduling, source priorities, matching or acquisition
worker settings. Existing pairing and service resource limits are preserved.

```
python3 apply-followup.py --install
```

The launcher verifies both expected input versions first. It briefly stops Aurral,
backs up its current DB and UI, applies the readiness UI, starts Aurral and checks
health/matcher availability. It then backs up and replaces only bridge.py and
restarts the Apple helper. If the old helper is stuck, its existing systemd stop
limit can take 65 seconds. The new browser has bounded operations and cleanup.

After success, hard-refresh Aurral (Ctrl+F5), then Connect Apple Music. Loading
and closing states hide the old screen and disable input. When Apple browser
ready appears, click Apple's red Sign In button inside the displayed browser,
select Apple's account field, and type or use the masked Send text box.

## What changed

Production logs identify a screen-capture failure followed by stuck cleanup.
This release replaces repeated synchronous Page.captureScreenshot calls with
CDP frame subscription/acknowledgement. Browser work runs in a disposable child
process; operation deadlines and cancellation kill an unresponsive browser tree,
remove its temporary profile and release admission. Credentials stay inside the
helper and authenticated internal communication, never the viewer. Request
observation uses existing event headers rather than another blocking header RPC.

One active sign-in browser, CPUQuota 50%, MemoryMax 1024M, no swap, ten-minute
sign-in timeout and per-user isolation remain. No new packages are installed.

## Validation and limits

- Headed Chromium under Xvfb: real frame/pointer/text/Enter and rendered page
  confirmation passed. Forced worker freeze was terminated within its deadline.
- Cancelling a genuinely frozen browser released its slot in under 0.3 seconds;
  another user started and received a live frame. Automatic failure cleanup
  without Cancel released admission in 8.036 seconds; a subsequent user
  received a live browser without restarting the service.
- React popup checks cover disabled/hidden controls before a frame and during
  closing, real browser UI events, success, cancel, disconnect and unconfigured UI.
- 17 Python bridge checks, guarded installer checks, and 9 offline TLS/auth route
  checks pass. Scope excludes production Apple credentials and imported tastes.
- Apple's live site is blocked by the cloud environment's outbound proxy; real
  Apple authentication is NOT established by these fixture tests. The final
  account-side check must happen on CT109. Do not call this end-to-end verified.

If either installer fails, stop and share the output; do not bypass file hashes
or repeat the full launcher after a partial installation. For diagnostics:
```
journalctl -u aurral-apple-browser --since "10 minutes ago" -n 30 --no-pager
```

Rollback, if needed (preserves current DB work and pairing):
```
python3 browser/apply-patch.py --rollback
python3 ui/apply-patch.py --rollback
systemctl start aurral.service
```
The prior helper is known to have capture issues; it can be left stopped with
`systemctl stop aurral-apple-browser`. This does not stop Aurral downloads.
