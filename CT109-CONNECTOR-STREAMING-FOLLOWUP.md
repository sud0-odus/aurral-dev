# CT109 bounded Apple public lookup follow-up

The current connector rejects Apple's public HTML at its 2,000,000-byte limit
(APPLE_WEB_PAGE_SIZE). This follow-up changes only adapters.js. It scans public
HTML for the bundle path, and public JavaScript for a complete valid AMPWebPlay
JWT, incrementally. Each scan stops and cancels its response as soon as the needed
value is found; it retains at most 128K decoded characters, not a full page/bundle.
Public scans have a hard 32 MiB transfer limit and retain the 15-second per-stage
budget, bounded same-origin redirects and no credential forwarding across hosts.
Private session validation JSON retains its existing 1,000,000-byte limit.
JWT matching uses a specific JSON-header prefix, bounded segments and a closing
delimiter, so a signature split across chunks cannot be accepted prematurely.

Inside CT109:
```
python3 apply-patch.py --install
python3 apply-patch.py --enable
```

Install verifies the expected previous validation-patch hash and then runs a
read-only public Apple lookup BEFORE stopping Aurral or changing any source/DB
files. The probe reads no account cookie, application database or private API.
Only a success flag or safe diagnostic code is printed; no web token is printed.
If the probe fails, Aurral stays running with its existing code. If it succeeds,
the installer stops Aurral, backs up source/current DB, installs one backend file
and leaves it paused until --enable checks health/matcher availability.

No extension reinstall, browser re-pairing, frontend update, cookie collection
or download scheduler changes are needed. After enable, close the old connector
popup, refresh Aurral and create one fresh Apple connection request.

Validation: 27 connector checks; 18 installer checks including preflight failure
before any service changes; actual payload fixture install/enable/rollback and
pairing preservation; source lint passed. Streaming fixtures cover a >3 MiB page
and >13 MiB bundle, split markers and signatures, early cancellation, hard-bound
failure and the unchanged private JSON limit. Two CPU adapter test guard sampled
76.1 MiB peak process-group RSS, elapsed one second. The real public-probe script
also passed a controlled redirect/large-page fixture without account credentials.
Live public lookup is deliberately checked on CT109 by installation. No live
account connection is claimed until the user's next service attempt succeeds.

Rollback, preserving current pairing/DB work:
```
python3 apply-patch.py --rollback
systemctl start aurral.service
```
