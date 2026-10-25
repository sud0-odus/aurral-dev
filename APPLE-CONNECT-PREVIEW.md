# Aurral CT109 hosted Apple sign-in preview

This preview supplies the new **Profile → Apple Music → Connect Apple Music** popup. It reuses the established Apple web-session mechanism. The previous Apple importer and multi-user imports are already proven; they are not being retested here.

The default deployment installs the browser service **inside CT109**, separately from aurral.service. A separate container is optional, not required. The hosted browser starts only after Connect is clicked. No Windows helper, MCP server on the desktop, or manual Apple-token copying is required.

## Preview scope

Connect, complete Apple's sign-in/verification in the popup, close the hosted browser, read the signed-in user's personal playlist metadata and original artwork availability, disconnect. The browser's private profile is temporary and deleted on cleanup; captured Apple headers stay only in service memory for up to one hour. A service restart requires reconnecting. This is not an additional Aurral sign-in method.

No playlists are imported and no music downloads are queued by this preview. Durable per-user taste storage, original-cover import/backfill and recommendation integration remain subsequent work after the popup is verified. Existing discovery inputs, feedback/reset behavior and acquisition configuration are untouched.

## Resource behavior on CT109

- Separate systemd unit, dedicated non-root service user, at most one browser session.
- Service CPUQuota=50% (half of one core), MemoryMax=1024M, MemorySwapMax=0, KillMode=control-group.
- A new browser is refused if the container's cgroup reports less than 1.25 GiB memory headroom after accounting for reclaimable inactive file cache. Active memory pressure causes a refusal instead of an attempted launch.
- Ten-minute sign-in deadline; 90-second abandonment timeout; explicit popup cancellation closes the browser. A cleanup watchdog kills the session's browser subprocess tree if graceful shutdown stalls.
- No browser/Xvfb process when idle; the small Python connection service stays available.
- The service listens only at 127.0.0.1:3334 by default. Aurral reaches it using HTTPS, a locally trusted certificate and a private service key. The one-time installer pairs these automatically; these are service credentials, not Apple tokens.
- Chromium and dependencies need disk space. Installation refuses when /opt has less than 2 GiB free.

## Install from N100S

Download the immutable release ZIP and extract it to a private directory on the Proxmox host, then:

```bash
python3 /root/aurral-apple-connect-preview/deploy.py --check
python3 /root/aurral-apple-connect-preview/deploy.py --install
```

The check only validates Debian CT109/resources, stages files under /tmp, and verifies source hashes. It does not stop a service or alter application files. Installation adds Chromium/Xvfb and a small Python service inside CT109, verifies private HTTPS pairing, then stops Aurral briefly for a code/database/frontend backup and guarded application/UI update. The queue is not reset. Aurral resumes after its health/matcher check.

The preview is compatible with this CT109's patch-5 or patch-6 acquisition stack; it checks the unchanged account files and the installed configurable Library boundary module. Unknown source changes are refused. Do not force it onto another build. No frontend build is needed inside CT109.

Only begin the install after --check reports PASS. If installation stops, consult /root/aurral-apple-deploy.log; it never contains Apple credentials. Do not run another copy concurrently.

## First live verification

1. Refresh Aurral. Open the individual Profile; Apple Music is between Connected accounts and Plex account.
2. Click Connect Apple Music and allow the popup. Click fields in the hosted browser and type normally, or use the masked input/Send text control for touch devices and paste.
3. Complete Apple's sign-in and verification. The popup should close only after an authenticated library request succeeds and the hosted browser has closed.
4. Click Check playlists. Confirm that the displayed collection belongs to the Apple account used for this Aurral user. This action is metadata-only.
5. Sign into the other Aurral account and connect its Apple account. One active sign-in at a time is intentional; completed connections remain separate.
6. Test Cancel and Disconnect. After closing a popup, allow a few seconds for cleanup. For interrupted network/browser clients, the abandonment timeout is 90 seconds.

Actual Apple sign-in in the hosted Linux browser has not been verified from the cloud environment. Apple verification prompts, remote browser compatibility and acceptance of the session are precisely the remaining live checkpoint, not the already proven playlist-import mechanism. The service does not bypass Apple authentication or challenges.

## Status and rollback

```bash
pct exec 109 -- systemctl show aurral-apple-browser -p ActiveState -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec
pct exec 109 -- journalctl -u aurral-apple-browser -n 15 --no-pager
```

Browser lifecycle logs contain state/error class only, not credentials, typed input or Apple response payloads.

```bash
python3 /root/aurral-apple-connect-preview/deploy.py --rollback
```

Rollback stops the browser service, restores the previous Aurral source/frontend and resumes Aurral. Current database/music work is retained. Packages and the private pairing configuration remain installed but inactive, so rollback does not remove dependencies other software might use. To reinstall the same preview, use --install again.

## Optional separate container

A Debian 12/13 CT with 1 CPU, 2 GiB RAM and enough disk is supported with `--browser-ct NUMBER`. This opts into a LAN listener and private certificate/key transfer through the Proxmox host. It is optional. Do not install this service on the Proxmox host itself.
