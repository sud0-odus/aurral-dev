# Validation

- News service regression suite: 14 passed, including disabled news preserving an expired article awaiting an image and making zero network calls. Guarded run peak 138.3 MiB, 1.0 s.
- Installer, collector and launcher: 25 tests passed. Includes current database preservation through rollback, prebuilt frontend replacement/rollback, payload corruption and symlink rejection, later edits protected, privacy allowlists, WAL visibility, memory breakdown, recoverable checkpoints and collector-only systemd limits.
- Production frontend build passed; guarded peak 918.1 MiB, 4.5 s. JSX/backend scoped ESLint and git diff --check passed.
- Patched application smoke: health and native matcher available; production HTML served; actual /proc collection identifies web/downloads roles; SIGTERM produces an interrupted final report. Guarded peak 276.2 MiB, 4.5 s. App stopped afterward.
- The first queue patch files are unchanged. Its prior 733-test regression and two worker integration tests are not re-run for this UI/news-only follow-up.

These checks do not establish live throughput or overnight memory stability. No connection to CT109 was made from the cloud. The detached systemd launch is verified with unit-test command inspection; the cloud smoke validates the collector independently of systemd.
