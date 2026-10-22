# Validation of queue-progress patch 1

- 733 download, track-matching and Honker regression tests passed; zero failures, cancellations or skips in the final run.
- Two supervised-worker integration tests passed: on-demand process lifecycle and download-owner IPC cancellation.
- Seven installer tests passed: install/enable/rollback, backups and permissions, unknown-source-file rejection, payload integrity, failed-health stop, partial-copy recovery, interrupted-install recovery, and preservation of post-install database work.
- Eight collector tests passed. The revised accounting also reproduced 37 source-attributed completions and 79 ambiguous non-reuse records from the uploaded baseline.
- Scoped backend ESLint and git diff whitespace checks passed.
- Installer preflight passed against exact original upstream v2.11 source files and the final four payload files.
- Patched backend startup, health, matcher and production HTML smoke checks passed.

The regression runner used two CPU cores and an aggregate-RSS stop guard at 3 GiB. Its peak sampled aggregate RSS was 455.2 MiB over 120.2 seconds; the guard did not trigger. The short patched-backend smoke run peaked at 651.8 MiB over 12 seconds. The test guard is not a container/cgroup memory quota or a sustained-load benchmark.

Two earlier test harnesses stubbed provider steps but unintentionally allowed the new dispatch wake to start real provider work; those fixtures now explicitly stub dispatch. A direct Usenet-adapter test now drains preceding background workers before replacing client methods. The final relevant regression run passed after isolating those fixtures. Production Usenet implementation was not changed.

The tests do not establish actual download throughput or long-term leak freedom on CT 109. No production service, database, settings, or media was changed during development. The follow-up observation after user installation is the production validation.
