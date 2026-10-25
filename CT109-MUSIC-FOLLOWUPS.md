# CT109 queue and Apple browser follow-ups

Run inside CT109: python3 apply-followups.py --install

Both expected input versions are verified first. The launcher then installs and
enables the backend queue fix, updates only the Apple browser, and starts a
one-hour detached read-only profile. Aurral is stopped briefly while its source
and database are backed up. Existing queue work and pairing are preserved.

Close the old Apple popup and retry Connect Apple Music. Let Aurral run normally.
Queue profile: /tmp/aurral-source-admission-109.json.gz
Progress: journalctl -u aurral-source-admission-profile -n 10 --no-pager

For individual steps/rollback use queue/README.md and apple/README.md. If any step
fails, later steps do not run. Do not repeat the full launcher after a partial
install; share the output to resume the appropriate step.

Queue validation: 866 regression tests, 34 installer/collector checks; Apple:
20 unit/installer checks, real Chromium fixture captures. See component docs for
limits. Production sustained throughput and Apple sign-in still need validation.
