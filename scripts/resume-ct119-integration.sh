#!/usr/bin/env bash
# Resume ONLY the pre-existing CT119 9144918 stage. Original checkout is never altered.
set -u
set -o pipefail
umask 077
say() { printf '%s\n' "$*"; }
fail() { say "RESUME_FAILED=$*"; exit 1; }
sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "need_original_40_character_commit"
[[ "$(id -u)" = 0 ]] || fail "run_as_CT119_root"
old=/opt/aurral-dev
data=/opt/aurral_data
short="${sha:0:12}"
dest="/opt/aurral-integration-$short"
state="$data/integration-backup-$short"
[[ -d "$dest/.git" || -f "$dest/.git" ]] || fail "staged_worktree_missing"
[[ -s "$state/locally-modified-tracked-files.patch" ]] || fail "original_local_diff_backup_missing"
[[ -f "$state/original-git-status.txt" ]] || fail "original_status_backup_missing"
[[ "$(git -C "$dest" rev-parse HEAD)" = "$sha" ]] || fail "staged_revision_not_expected"
[[ -f "$data/aurral.db" ]] || fail "database_missing"
[[ ! -f "$state/staged-commit.txt" ]] || fail "stage_already_completed"

# Confirm the ONLY five local edits are the documented Apple taste patch.
actual="$(git -C "$old" diff --name-only | LC_ALL=C sort)"
expected="$(printf '%s\n' \
  .tests/discovery/personal-recommendations.test.js \
  backend/services/discovery/provider.js \
  backend/services/discovery/recommendationPipeline.js \
  backend/services/discovery/userDiscovery.js \
  backend/services/flows/flowTrackSource.js | LC_ALL=C sort)"
[[ "$actual" = "$expected" ]] || fail "unexpected_local_code_changes_need_review"

# These three overlapping files already contain the merged, tested Apple
# taste behavior in PR #14. Keep the PR's version in the STAGED tree.
# The ORIGINAL checkout and full binary diff remain untouched and backed up.
for name in \
  .tests/discovery/personal-recommendations.test.js \
  backend/services/discovery/provider.js \
  backend/services/flows/flowTrackSource.js; do
  git -C "$dest" diff --quiet HEAD -- "$name" ||
    fail "overlapping_file_modified_in_stage:$name"
done
grep -q 'getAppleMusicPlaylistSeeds' "$dest/backend/services/discovery/provider.js" ||
  fail "Apple_personal_taste_not_present"
grep -q 'mergePersonalArtistSources' "$dest/backend/services/discovery/provider.js" ||
  fail "personal_source_merger_not_present"
grep -q 'getUserDiscovery(options.ownerUserId' "$dest/backend/services/flows/flowTrackSource.js" ||
  fail "owner_scoping_not_present"
say "APPLE_TASTE_PRESERVED_IN_INTEGRATED_SOURCE=yes"
say "THREE_CONFLICTS_RESOLVED_BY_EXISTING_PR14_CODE=yes"
say "ORIGINAL_CHECKOUT_UNTOUCHED=yes"

for name in .env backend/.env; do
  if [[ -f "$old/$name" && ! -e "$dest/$name" ]]; then
    ln -s "$old/$name" "$dest/$name" || fail "local_env_link_failed"
  fi
done
cd "$dest" || fail "worktree_unavailable"
say "=== RUN STAGING BUILD AND TESTS ==="
npm ci --no-audit --no-fund > "$state/npm-install.log" 2>&1 ||
  fail "npm_ci_failed_see_local_log"
npm run lint > "$state/lint.log" 2>&1 ||
  fail "lint_failed_see_local_log"
npm run build > "$state/build.log" 2>&1 ||
  fail "build_failed_see_local_log"
node --test --import ./.tests/setup-env.js \
  .tests/discovery/personal-recommendations.test.js \
  .tests/discovery/personal-taste-sources.test.js \
  .tests/discovery/editorial-playlist-ranking.test.js \
  .tests/playlists/playlist-artwork-sources.test.js \
  .tests/download/download-watchdog.test.js \
  .tests/download/slskd-search-steps.test.js \
  > "$state/focused-tests.log" 2>&1 ||
  fail "focused_tests_failed_see_local_log"

# The SQLite backup is online/WAL-safe and does not stop the app.
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
[[ "$?" = 0 && -s "$state/aurral-before-pilot.db" ]] ||
  fail "database_backup_failed_see_local_log"
printf '%s\n' "$sha" > "$state/staged-commit.txt"
say "STAGING_VALIDATED=yes"
say "DATABASE_BACKUP_CREATED=yes"
say "ORIGINAL_APP_SERVICE_UNCHANGED=yes"
say "SECRETS_EXPORTED=no"
say "ACTIVATION_PENDING=yes"
