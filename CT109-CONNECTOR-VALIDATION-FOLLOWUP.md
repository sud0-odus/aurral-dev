# CT109 connector Apple validation follow-up

Confirmed on CT109: GET https://music.apple.com/us/browse returns HTTP 301 to
https://music.apple.com/us/new; following it returns HTTP 200 and the expected
/assets/index~ea66e33958.js bundle. Preview 0.1 used redirect:error, so web-token
lookup failed before Apple session validation. The working MCP follows redirects.

This follow-up permits only bounded same-origin redirects, with one 15-second
budget per HTTP stage. Apple session headers are never forwarded to a different
origin, an insecure URL or a credential-bearing URL. Parser behavior keeps the
confirmed existing bundle format. It adds stage-specific safe errors and logs
(code/stage/provider status only), and displays those errors in the Profile UI.
No session/cookie/request body/provider body is logged or returned in diagnostics.

Inside CT109:
```
python3 apply-patch.py --check
python3 apply-patch.py --install
python3 apply-patch.py --enable
```

Installer checks all three expected connector-preview input files, makes a local
source/frontend/current-DB backup, briefly stops Aurral, installs and checks health.
No extension files, pairing store, download worker settings or service priorities
are changed. Existing browser pairing is preserved; do not reinstall the extension.
After success, close any old connector popup and Ctrl+F5 Aurral, then create ONE
fresh Connect Apple Music request and approve it from the toolbar as before.
If another stage fails, the Profile now shows the specific code/message.

Validation: 23 connector tests, including the exact browse-to-new redirect,
bounded redirect loops, shared per-stage timeout, private-session redirect blocking,
provider rejection vs bootstrap rejection, safe API errors and stored session
isolation; 17 installer tests; real React diagnostic display with Chrome API shim;
actual three-file/prebuilt-frontend fixture install/enable/rollback with pairing
preservation; scoped backend/UI lint and production frontend build passed.
Public redirect was measured on CT109, but live account validation after this
fix still requires the next user-side connection attempt. Full browser extension
loading remains outside this managed cloud's test capabilities.

Rollback (preserves current DB and pairings):
```
python3 apply-patch.py --rollback
systemctl start aurral.service
```
