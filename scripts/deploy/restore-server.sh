#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'restore-server: %s\n' "$*" >&2
  exit 1
}

is_within() {
  case "$1/" in
    "$2/"*) return 0 ;;
    *) return 1 ;;
  esac
}

[[ $# -eq 1 ]] || fail "usage: restore-server.sh <backup-directory>"
[[ "${A446_MAINTENANCE_CONFIRMED:-}" == "yes" ]] || fail "stop Server Hub, then set A446_MAINTENANCE_CONFIRMED=yes"
[[ "${A446_RESTORE_CONFIRMED:-}" == "yes" ]] || fail "set A446_RESTORE_CONFIRMED=yes after verifying the exact target database and Artifact root"
[[ -n "${A446_DATABASE_URL:-}" ]] || fail "A446_DATABASE_URL is not set"
[[ -n "${A446_ARTIFACT_ROOT:-}" ]] || fail "A446_ARTIFACT_ROOT is not set"
command -v node >/dev/null 2>&1 || fail "node is not available"
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not available"
command -v psql >/dev/null 2>&1 || fail "psql is not available"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is not available"
command -v realpath >/dev/null 2>&1 || fail "realpath is not available"

backup_directory="$(realpath "$1")"
[[ -f "$backup_directory/COMPLETE" ]] || fail "backup is incomplete or missing COMPLETE marker"
[[ -f "$backup_directory/a446.dump" ]] || fail "database dump is missing"
[[ -d "$backup_directory/artifacts" ]] || fail "Artifact snapshot is missing"
[[ -f "$backup_directory/SHA256SUMS" ]] || fail "checksum file is missing"
(
  cd -- "$backup_directory"
  sha256sum --check SHA256SUMS
)

target="$(realpath -m "$A446_ARTIFACT_ROOT")"
target_parent="$(dirname -- "$target")"
[[ -d "$target_parent" ]] || fail "Artifact target parent does not exist: $target_parent"
target_parent="$(realpath "$target_parent")"
target="${target_parent}/$(basename -- "$target")"
[[ "$target" != "/" && "$target" != "$HOME" ]] || fail "refusing broad Artifact target: $target"
depth="$(printf '%s' "$target" | tr -cd '/' | wc -c | tr -d ' ')"
[[ "$depth" -ge 3 ]] || fail "Artifact target is too broad: $target"
if is_within "$target" "$backup_directory" || is_within "$backup_directory" "$target"; then
  fail "backup directory and Artifact target must not contain one another"
fi
[[ ! -L "$target" ]] || fail "Artifact target must not be a symbolic link"
[[ ! -e "$target" || -d "$target" ]] || fail "Artifact target must be a directory"

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target_name="$(basename -- "$target")"
staging="${target_parent}/.${target_name}.restore-${stamp}"
rollback="${target_parent}/${target_name}.rollback-${stamp}"
failed="${target_parent}/${target_name}.failed-${stamp}"
[[ ! -e "$staging" && ! -e "$rollback" && ! -e "$failed" ]] || fail "restore staging path collision"
mkdir -- "$staging"
cp -a -- "$backup_directory/artifacts/." "$staging/"

had_previous=false
if [[ -d "$target" ]]; then
  mv -- "$target" "$rollback"
  had_previous=true
fi
if ! mv -- "$staging" "$target"; then
  if [[ "$had_previous" == true ]]; then mv -- "$rollback" "$target"; fi
  fail "could not activate restored Artifact snapshot"
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
restore_sql="$(mktemp "${backup_directory}/.restore-XXXXXXXX.sql")"
cleanup_restore_sql() {
  rm -f -- "$restore_sql"
}
trap cleanup_restore_sql EXIT
if ! {
  printf 'DROP SCHEMA public CASCADE;\n'
  printf 'CREATE SCHEMA public AUTHORIZATION CURRENT_USER;\n'
  pg_restore \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    --file=- \
    "$backup_directory/a446.dump"
} > "$restore_sql"; then
  mv -- "$target" "$failed"
  if [[ "$had_previous" == true ]]; then mv -- "$rollback" "$target"; fi
  fail "could not prepare database restore; previous Artifact target was restored"
fi

if ! node "$script_directory/run-postgres-client.mjs" psql \
  --set=ON_ERROR_STOP=1 \
  --single-transaction \
  --file="$restore_sql"; then
  mv -- "$target" "$failed"
  if [[ "$had_previous" == true ]]; then mv -- "$rollback" "$target"; fi
  fail "database restore failed; previous Artifact target was restored and failed snapshot was kept at $failed"
fi
cleanup_restore_sql
trap - EXIT

printf 'Restore complete. Artifact target: %s\n' "$target"
if [[ "$had_previous" == true ]]; then
  printf 'Previous Artifact snapshot retained for rollback: %s\n' "$rollback"
fi
printf 'Run migrations, start Server Hub, and verify health, login, pending interventions, and Artifact downloads.\n'
