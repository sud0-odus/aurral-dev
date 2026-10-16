#!/usr/bin/env bash
# CT119 pilot installer. No credentials are read into output or written to Git.
# The original checkout is never reset, cleaned, switched, or overwritten.
set -u
set -o pipefail
umask 077
say() { printf '%s\n' "$*"; }
fail() { say "INSTALL_FAILED=$*"; exit 1; }

old=/opt/aurral-dev
data=/opt/aurral_data
unit=aurral.service
sha="$1"
mode="$2"
[[ "$(id -u)" -eq 0 ]] || fail "run_as_root_inside_CT119"
[[ "$mode" = stage || "$mode" = activate ]] || fail "mode_must_be_stage_or_activate"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "need_pinned_git_commit"
[[ -d "$old/.git" || -f "$old/.git" ]] || fail "original_checkout_missing"
[[ -f "$data/aurral.db" ]] || fail "database_missing"
git -C "$old" cat-file -e "$sha^{commit}" 2>/dev/null || fail "commit_not_fetched"

short="$(printf '%s' "$sha" | cut -c1-12)"
dest="/opt/aurral-integration-$short"
state="$data/integration-backup-$short"
unitDir=/etc/systemd/system/aurral.service.d
dropin="$unitDir/90-ct119-integration.conf"

if [[ "$mode" = stage ]]; then
  [[ ! -e "$dest" ]] || fail "staging_tree_exists"
  [[ ! -e "$state" ]] || fail "staging_backup_exists"
  [[ ! -e "$dropin" ]] || fail "integration_override_already_exists"
  mkdir -p "$state" || fail "unable_to_create_backup"
  git -C "$old" diff --binary > "$state/locally-modified-tracked-files.patch" ||
    fail "unable_to_save_local_diff"
  git -C "$old" status --porcelain > "$state/original-git-status.txt" ||
    fail "unable_to_save_local_status"
  systemctl cat "$unit" > "$state/original-systemd-unit.txt" ||
    fail "unable_to_save_unit"
  systemctl is-active "$unit" > "$state/original-service-state.txt" || true
  git -C "$old" worktree add --detach "$dest" "$sha" ||
    fail "unable_to_create_new_worktree"
  say "WORKTREE_CREATED=yes"
  say "ORIGINAL_CHECKOUT_UNTOUCHED=yes"

  conflicts=0
  while IFS= read -r -d '' name; do
    if [[ ! -f "$old/$name" || ! -f "$dest/$name" ]]; then
      say "MERGE_NEEDS_REVIEW=$name"
      conflicts=$((conflicts+1))
      continue
    fi
    original="$(mktemp)" || fail "temporary_file_failed"
    merged="$(mktemp)" || fail "temporary_file_failed"
    if ! git -C "$old" show "HEAD:$name" > "$original"; then
      say "MERGE_NEEDS_REVIEW=$name"
      conflicts=$((conflicts+1))
    elif git merge-file -p "$dest/$name" "$original" "$old/$name" > "$merged"; then
      cat "$merged" > "$dest/$name" || fail "unable_to_write_merge"
      say "MERGED_LOCAL_CHANGE=$name"
    else
      # Preserve the conflict locally, never add credentials to Git.
      cp "$merged" "$state/conflict-$(basename "$name")" || true
      say "MERGE_CONFLICT=$name"
      conflicts=$((conflicts+1))
    fi
    rm -f "$original" "$merged"
  done < <(git -C "$old" diff --name-only -z)
  if [[ "$conflicts" -gt 0 ]]; then
    say "ACTIVATION_BLOCKED=merge_conflict"
    fail "review_local_changes_before_activation"
  fi

  # The live Apple POC directory, local certificates and all untracked files
  # are deliberately left in the original checkout.
  for name in .env backend/.env; do
    if [[ -f "$old/$name" && ! -e "$dest/$name" ]]; then
      ln -s "$old/$name" "$dest/$name" || fail "env_link_failed"
    fi
  done
  cd "$dest" || fail "unable_to_enter_integration_tree"
  npm ci --no-audit --no-fund > "$state/npm-install.log" 2>&1 ||
    fail "npm_ci_failed_details_local_only"
  npm run lint > "$state/lint.log" 2>&1 ||
    fail "lint_failed_details_local_only"
  npm run build > "$state/build.log" 2>&1 ||
    fail "build_failed_details_local_only"
  node --test --import ./.tests/setup-env.js \
    .tests/discovery/personal-recommendations.test.js \
    .tests/discovery/personal-taste-sources.test.js \
    .tests/discovery/editorial-playlist-ranking.test.js \
    .tests/playlists/playlist-artwork-sources.test.js \
    .tests/download/download-watchdog.test.js \
    .tests/download/slskd-search-steps.test.js \
    > "$state/focused-tests.log" 2>&1 ||
    fail "regression_test_failed_details_local_only"

  # SQLite online backup captures committed transactions even with an active WAL.
  node --input-type=module - "$data/aurral.db" "$state/aurral-before-pilot.db" \
    > "$state/db-backup.log" 2>&1 <<'NODE_BACKUP'
import Database from "better-sqlite3";
const [, , source, destination] = process.argv;
const connection = new Database(source, { readonly: true, fileMustExist: true });
try {
  await connection.backup(destination);
} finally {
  connection.close();
}
NODE_BACKUP
  [[ "$?" -eq 0 && -s "$state/aurral-before-pilot.db" ]] ||
    fail "database_backup_failed_details_local_only"
  printf '%s\n' "$sha" > "$state/staged-commit.txt"
  say "STAGING_VALIDATED=yes"
  say "DATABASE_BACKUP_CREATED=yes"
  say "SECRETS_EXPORTED=no"
  say "STAGING_ID=$short"
  say "ACTIVATION_PENDING=yes"
  exit 0
fi

[[ -f "$state/staged-commit.txt" ]] || fail "run_stage_first"
[[ "$(cat "$state/staged-commit.txt")" = "$sha" ]] || fail "staged_revision_mismatch"
[[ -f "$state/aurral-before-pilot.db" ]] || fail "rollback_database_missing"
[[ -f "$dest/frontend/dist/index.html" ]] || fail "frontend_build_missing"
[[ ! -e "$dropin" ]] || fail "integration_override_already_exists"
oldstate="$(cat "$state/original-service-state.txt")"

# An inactive aurral.service with an occupied port means another launcher
# may own the app. Do not restart or replace that process automatically.
if [[ "$oldstate" != active ]]; then
  if ss -ltnH '( sport = :3001 )' | grep -q .; then
    fail "port_3001_owned_by_unmanaged_process_investigate_launcher"
  fi
fi
mkdir -p "$unitDir" || fail "cannot_create_service_override_directory"
printf '[Service]\nWorkingDirectory=%s\n' "$dest" > "$dropin" ||
  fail "cannot_write_service_override"
if ! systemctl daemon-reload; then
  rm -f "$dropin"
  fail "daemon_reload_failed"
fi
say "SERVICE_STARTING=yes"
systemctl restart "$unit" || true
healthy=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$unit" &&
     curl -fsS --max-time 2 http://127.0.0.1:3001/api/health \
       > "$state/health.json" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" -ne 1 ]]; then
  systemctl stop "$unit" || true
  rm -f "$dropin"
  systemctl daemon-reload || true
  if [[ "$oldstate" = active ]]; then systemctl start "$unit" || true; fi
  say "SERVICE_OVERRIDE_REVERTED=yes"
  say "ORIGINAL_CHECKOUT_UNTOUCHED=yes"
  say "DATABASE_BACKUP_AVAILABLE=yes"
  fail "health_check_failed_check_local_journal"
fi
say "CT119_RUNNING_INTEGRATION=yes"
say "ORIGINAL_CHECKOUT_UNTOUCHED=yes"
say "DATABASE_BACKUP_AVAILABLE=yes"
say "SECRETS_EXPORTED=no"
say "STAGING_ID=$short"
