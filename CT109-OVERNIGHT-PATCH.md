# CT109 overnight follow-up (v2.11.0 with queue-progress-1 already installed)

This follow-up preserves the first queue patch, concurrency 2, its six-job automatic admission cap, source priorities, discovery settings and transcoding settings. It does not implement independent source pools or change slskd fallback timing.

Changes:
- Disabled RSS news returns before fetching feeds, maintaining stored articles, or looking up missing article images. Its scheduled entry can still complete as a no-op every 15 minutes.
- The top-right account control displays the signed-in username's first initial, with the full username in its tooltip. Generic user icon when no username is available.
- Prebuilt frontend included: no npm install/build on the N100.
- Collector 1.2 identifies background task queues/kinds, exports known worker roles and sampled per-process CPU/RSS, and captures cgroup memory.stat anon/file/shmem/kernel. It keeps initially blocked completions separate. Task duration/overlap is not proof of CPU attribution.
- Detached eight-hour profiling with 30-second samples and an atomic checkpoint every five minutes. SIGTERM saves an early final report.

## Install inside CT109, as root

Run `python3 apply-patch.py --check`, then `--install`, then `--enable` from this directory. Defaults: application `/opt/aurral`, database `/opt/aurral_data/aurral.db`. `--check` verifies the four already-patched backend files, the two original v2.11 UI/news source files, and the bundled build. It refuses unexpected source edits.

`--install` stops aurral.service, backs up the stopped SQLite database, the six source files and the entire existing frontend build under `/opt/aurral-patch-backups`, installs the payload and leaves Aurral stopped. It does not edit database rows, settings, media files or other containers. `--enable` verifies the installed files, starts Aurral and checks health/matcher availability. Reload the browser (Ctrl+F5) for the initial badge.

The four queue backend files in the payload are byte-for-byte identical to the first patch. The separate marker `/opt/aurral-overnight-patch.json` preserves that first patch's marker and backup.

## Overnight measurement

After successful enable, run `python3 start-profile.py`. The default observation lasts eight hours and is independent of the SSH connection. Leave concurrency at 2 and settings unchanged; reviewing tracks is allowed, but the report separates their initial state and cannot reconstruct every user action.

The profiler alone has MemoryMax=384M, MemorySwapMax=0, CPUQuota=20% of one CPU, Nice=10 and private output permissions. These are not new limits on Aurral. No restart or runtime limit is applied to Aurral. Sampling may miss short-lived child processes or brief spikes. The pre-existing 50,000-run / 20,000-sample limits remain; truncation is explicitly flagged.

Progress: `journalctl -u aurral-overnight-profile -n 10 --no-pager`

Output: `/tmp/aurral-overnight-109.json.gz`, `.md`, `.jobs.csv`; recoverable `.checkpoint.json.gz` updated every five minutes. All exports omit raw payloads, track titles, URLs, tokens, environment contents, logs and media paths. Process IDs, known worker groups and numeric counters are included. No collected production data is in this kit or published to GitHub.

To finish early and save: `systemctl stop aurral-overnight-profile`. Do not use kill -9. If the profiler is OOM-killed or CT reboots, upload its last checkpoint instead; /tmp is not guaranteed to survive reboot. Aurral continues running if just the collector is stopped or fails.

Fetch the result from the Proxmox host:
`pct pull 109 /tmp/aurral-overnight-109.json.gz /root/aurral-overnight-109.json.gz`

Then Windows PowerShell:
`scp root@192.168.1.141:/root/aurral-overnight-109.json.gz "$HOME\Downloads\"`

## Rollback this follow-up only

`python3 apply-patch.py --rollback` restores the six source files and frontend from this follow-up's backup, leaving the first queue patch in place. Current database/work is preserved; the database backup is not restored automatically. Service remains stopped. Resume with `systemctl start aurral.service`.

Do not use the first kit's rollback to undo this follow-up. Stop the profiler first if a clean comparison window is needed.
