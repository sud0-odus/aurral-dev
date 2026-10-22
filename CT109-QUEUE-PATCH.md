# CT 109 — Aurral v2.11.0 queue-progress patch 1

This patch targets the stall measured on CT 109. It changes four backend files and needs no dependency installation or frontend rebuild.

- A Soulseek search still reported as queued after 15 minutes raises `SLSKD_SEARCH_BUSY`, cleans up its owned search, and follows Aurral's existing next-source/failure path. It does not cache an empty search result or keep submitting queries to the congested source. An already-old search is checked against slskd before abandonment; if it has started running, it retains its normal result-collection window.
- After each pipeline step, dispatch wakes outside the playlist lock and can restart after becoming idle. An explicit in-process worker stop prevents this automatic restart. As before, a service restart runs startup recovery; UI worker Stop is not a persistent all-service pause.
- Existing search concurrency remains 2 on your installation. Automatic admission has an additional ceiling of six distinct in-flight pipeline jobs, counting preparatory jobs conservatively. Waiting transfers therefore have bounded capacity while new searches/imports can proceed. Explicit/manual requests and tracks grouped into an album are not additional independent automatic-admission slots.
- The patch does not introduce separate parallel stage-worker pools or change transcoding, source priorities, retry-cycle pauses, or database schema. It is the first bounded queue-progress fix; live throughput improvement remains to be measured.

## Download and preflight (PuTTY on the Proxmox host)

Use only **CT 109**. Commands are run at `root@N100S`, not Windows PowerShell:

```bash
pct exec 109 -- curl -fL https://raw.githubusercontent.com/sud0-odus/aurral-dev/artifacts/aurral-baseline/aurral-ct109-queue-patch.zip -o /tmp/aurral-ct109-queue-patch.zip
pct exec 109 -- python3 -m zipfile -e /tmp/aurral-ct109-queue-patch.zip /tmp/aurral-ct109-queue-patch
pct exec 109 -- python3 /tmp/aurral-ct109-queue-patch/apply-patch.py --check
```

Preflight verifies the new payload's SHA-256 checksums, JavaScript syntax, and the exact original SHA-256 of each of the four v2.11 files. It makes no service/application changes. If it rejects a file, stop and share the error; do not force installation. The helper installation paths are `/opt/aurral` and `/opt/aurral_data/aurral.db`; the tool has explicit overrides for custom installations.

## Pause and install

After preflight prints PASS:

```bash
pct exec 109 -- python3 /tmp/aurral-ct109-queue-patch/apply-patch.py --install
```

This stops `aurral.service`, so the entire Aurral web application is briefly unavailable and its workers stop. Other CTs are untouched; external clients may finish transfers Aurral already submitted.

While stopped, the installer rechecks original files, backs up the four source files and the complete SQLite database under `/opt/aurral-patch-backups/queue-progress-*`, and atomically replaces the source files. It preserves file ownership/modes and writes an install marker at `/opt/aurral-queue-patch.json`. The backup directory is private (0700), and the database backup is 0600. Database records, queue entries, settings, manifests, dependencies and media are not edited. A caught file-copy failure restores files already changed and leaves Aurral stopped.

**The installer leaves Aurral stopped.** Do not run a helper/upstream update during this trial; it can replace the patched source files.

## Enable and confirm health

```bash
pct exec 109 -- python3 /tmp/aurral-ct109-queue-patch/apply-patch.py --enable
```

This verifies the patched files, starts Aurral, and checks the local health endpoint and matcher. If health does not pass, it stops Aurral again. It does not restore an older database automatically. Normal startup recovery resumes eligible pending jobs; allow roughly 10 seconds after enabling. Leave concurrency at 2 for this comparison. Do not clear or recreate the existing backlog.

## Collect a 30-minute follow-up

```bash
pct exec 109 -- python3 /tmp/aurral-ct109-queue-patch/aurral-baseline.py --hours 24 --observe-seconds 1800 --interval 10 --output /tmp/aurral-post-patch-109
pct pull 109 /tmp/aurral-post-patch-109.json.gz /root/aurral-post-patch-109.json.gz
```

The collector does not modify Aurral or settings. It samples while the existing queue runs and prints progress once per minute. It reports the post-patch observation separately from the historical 24-hour lookback, which contains pre-patch records. The revised collector explicitly separates source-attributed non-reuse completions from ambiguous source-unknown records, matching the corrected initial baseline (37 source-attributed completions; 79 ambiguous records excluded).

Download in Windows PowerShell:

```powershell
scp root@192.168.1.141:/root/aurral-post-patch-109.json.gz "$HOME\Downloads\"
```

Attach the compressed JSON in chat. Compare live source-attributed completions/hour, backlog movement, repeated search-stage jobs, stage durations, CPU, memory and swap. A healthy HTTP endpoint alone is not proof the backlog progresses. A 30-minute rate is a directional comparison, not a claim of sustained overnight performance.

## Roll back if needed

```bash
pct exec 109 -- python3 /tmp/aurral-ct109-queue-patch/apply-patch.py --rollback
pct exec 109 -- systemctl start aurral.service
```

Rollback verifies current/backup source checksums, stops Aurral, and restores only the four original source files. It leaves Aurral stopped until the second command. It preserves the current database and any work completed since installation. The database backup remains available for manual recovery; restoring it would discard subsequent database changes, so rollback never does so automatically. Unknown later source edits are not overwritten.

## Package contents

`manifest.json` identifies the exact v2.11 baseline and source checksums. `files/` contains the four new source files. `source-review.patch` includes the source and regression-test diff for review. `aurral-baseline.py` is the revised read-only measurement collector. The installer tests are included for audit and use simulated systemd operations and a temporary SQLite database; they do not act on the host's real service.
