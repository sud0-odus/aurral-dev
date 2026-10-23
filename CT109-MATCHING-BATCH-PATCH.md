# CT109 collaboration matching and follow-up batching (patch 3)

Requires v2.11.0 with both queue-progress-1 and overnight-2 already installed. This is an incremental backend update: it retains the disabled-news fix and installed user-initial UI. No dependency install or frontend build is needed.

## Behavior

- A combined requested artist credit can be confirmed by the actual artist tags plus explicit featured-artist credits in the file's original title/filename. Every named collaborator must be supported at the normal artist threshold, and at least one must match the actual artist tag. Lead-only evidence or an unrelated performer with the requested names in a title is insufficient.
- A collaboration can be hosted on one credited performer's YouTube channel. File validation still requires the requested collaboration evidence, correct title/version, duration and quality.
- The concrete regression case is `Megan Thee Stallion & Dua Lipa / Sweetest Pie` versus artist `Megan Thee Stallion` and original filename `18 Sweetest Pie (Feat. Dua Lipa).mp3`. Tests also reject missing collaborator evidence, unrelated performers and a remix conflict. No global artist/duration threshold is lowered.
- Incremental Library scans accumulate changed paths for a fixed 30-second window. Further events merge into the pending job without postponing it. All paths are retained, including pending work arriving during an active scan. Full/forced scans are immediate and expedite pending batches. The Library may take up to roughly 30 additional seconds to reflect new files; downloads are still committed promptly.
- Metadata enrichment no longer requests a full Library scan after every update. It schedules a targeted scan only for downloaded files whose job metadata changed, and skips filesystem scanning when only pending tracks or playlist metadata changed.
- Metadata-enrichment requests for one playlist share one pending queue job. Stronger reconciliation flags, earlier requested execution and higher priority are preserved. A request arriving while processing creates a pending follow-up; different playlists remain separate. The operation is transactional and tested with independent producer processes.
- Existing queue progress wakeups, concurrency 2, six-job automatic admission bound, source priorities and transcoding settings remain unchanged. This does not introduce independent source worker pools.
- Existing Review files are NOT bulk approved, denied or requeued. Some will still require a decision; this patch targets new attempts and retries through the validator.

## Install inside CT109

Run `python3 apply-patch.py --check`, then `--install`, then `--enable` from this directory. Defaults: app `/opt/aurral`, database `/opt/aurral_data/aurral.db`.

The check verifies expected source hashes from the previous two patches and the five new payloads. It refuses unknown source edits. Installation stops aurral.service, backs up the database and source files under `/opt/aurral-patch-backups`, writes the source payloads and leaves Aurral stopped. Enable verifies files, starts the app and checks health/matcher availability. No queue/database rows, settings, media files or other containers are edited by the installer. The source count includes six unchanged guard files and five changed backend files.

Separate marker: `/opt/aurral-matching-batch-patch.json`. Earlier patch markers and backups are retained.

## Two-hour follow-up

After enable, run `python3 start-profile.py --hours 2`. You can close PuTTY. Do not change concurrency, provider priorities or VPN routing during this comparison. Results: `/tmp/aurral-matching-batch-109.json.gz`, `.md`, `.jobs.csv`, and a recoverable checkpoint every five minutes.

Progress: `journalctl -u aurral-matching-batch-profile -n 10 --no-pager`.

Collector-only limits: 384 MiB RAM, no swap, 20% of one CPU and Nice=10. No new limits apply to Aurral. Stop early and save with `systemctl stop aurral-matching-batch-profile`.

Collector 1.3 retains memory components, known process roles, background task timestamps and pseudonymous job IDs. It adds fixed diagnostic labels for review/failure reasons without exporting raw errors, URLs, credentials or track names. Failure labels may describe earlier sources in a combined error message; they are not proof that the final source caused every listed error. Generic/unrecognized reasons remain `other`. Short child processes can be missed. Truncation limits remain explicit. Initial Review completions remain separate.

From Proxmox:
`pct pull 109 /tmp/aurral-matching-batch-109.json.gz /root/aurral-matching-batch-109.json.gz`

Windows PowerShell:
`scp root@192.168.1.141:/root/aurral-matching-batch-109.json.gz "$HOME\Downloads\"`

## Rollback this update only

`python3 apply-patch.py --rollback`, then `systemctl start aurral.service`.

Rollback restores the previous source, retaining both earlier fixes and the UI. The current database and completed work are preserved; the backup database is not restored automatically. Stop the profile first if a clean comparison window is needed. Use this kit's rollback, not an earlier kit's rollback, to undo patch 3.

No live production reports, databases, credentials or logs are included in this kit or published.
