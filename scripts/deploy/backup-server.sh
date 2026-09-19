#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'backup-server: %s\n' "$*" >&2
  exit 1
}

is_within() {
  case "$1/" in
    "$2/"*) return 0 ;;
    *) return 1 ;;
  esac
}

[[ $# -eq 1 ]] || fail "usage: backup-server.sh <backup-root>"
[[ "${A446_MAINTENANCE_CONFIRMED:-}" == "yes" ]] || fail "stop Server Hub, then set A446_MAINTENANCE_CONFIRMED=yes"
[[ -n "${A446_DATABASE_URL:-}" ]] || fail "A446_DATABASE_URL is not set"
[[ -n "${A446_ARTIFACT_ROOT:-}" ]] || fail "A446_ARTIFACT_ROOT is not set"
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is not available"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is not available"
command -v realpath >/dev/null 2>&1 || fail "realpath is not available"

artifact_root="$(realpath "${A446_ARTIFACT_ROOT}")"
[[ -d "$artifact_root" ]] || fail "A446_ARTIFACT_ROOT is not an existing directory"
mkdir -p -- "$1"
backup_root="$(realpath "$1")"
if is_within "$backup_root" "$artifact_root" || is_within "$artifact_root" "$backup_root"; then
  fail "backup root and Artifact root must not contain one another"
fi

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_directory="${backup_root}/a446-${stamp}"
[[ ! -e "$backup_directory" ]] || fail "backup directory already exists: $backup_directory"
mkdir -- "$backup_directory"
touch -- "$backup_directory/INCOMPLETE"

PGDATABASE="$A446_DATABASE_URL" pg_dump \
  --format=custom \
  --file="$backup_directory/a446.dump"

mkdir -- "$backup_directory/artifacts"
cp -a -- "$artifact_root/." "$backup_directory/artifacts/"

(
  cd -- "$backup_directory"
  sha256sum a446.dump > SHA256SUMS
)
database_sha256="$(cut -d ' ' -f 1 "$backup_directory/SHA256SUMS")"
{
  printf 'formatVersion=1\n'
  printf 'createdAt=%s\n' "$stamp"
  printf 'databaseFormat=postgres-custom\n'
  printf 'databaseSha256=%s\n' "$database_sha256"
  printf 'artifactSnapshot=artifacts\n'
  printf 'consistency=server-stopped-maintenance-window\n'
} > "$backup_directory/MANIFEST.txt"
mv -- "$backup_directory/INCOMPLETE" "$backup_directory/COMPLETE"

printf 'Backup complete: %s\n' "$backup_directory"
printf 'Keep the database dump and Artifact snapshot together as one recovery unit.\n'
