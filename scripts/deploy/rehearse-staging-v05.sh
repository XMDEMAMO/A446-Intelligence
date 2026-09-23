#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'rehearse-staging-v05: %s\n' "$*" >&2
  exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || fail "usage: rehearse-staging-v05.sh <candidate-release-name> <pre-deploy-backup> [https-origin]"

candidate_name="$1"
pre_deploy_backup="$2"
public_origin="${3:-https://staging.a446intelligence.party}"
releases_root="${A446_RELEASES_ROOT:-/srv/a446/releases}"
current_link="${A446_CURRENT_LINK:-/srv/a446/current}"
web_root="${A446_WEB_ROOT:-/var/www/a446-staging}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
candidate_release="$(realpath "${releases_root}/${candidate_name}")"
pre_deploy_backup="$(realpath "$pre_deploy_backup")"
runtime_environment="$(mktemp /run/a446-rehearsal-environment.XXXXXX)"

cleanup() {
  rm -f -- "$runtime_environment"
  if ! systemctl is-active --quiet a446-server-hub; then
    systemctl start a446-server-hub || true
  fi
}
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || fail "run this script as root"
[[ "$(dirname -- "$candidate_release")" == "$(realpath "$releases_root")" ]] || fail "candidate must be a direct child of $releases_root"
[[ -f "$candidate_release/apps/server-hub/src/server-hub-cli.mjs" ]] || fail "candidate Server Hub is missing"
[[ -f "$candidate_release/apps/web/dist/index.html" ]] || fail "candidate Web build is missing"
[[ -f "$pre_deploy_backup/COMPLETE" && ! -e "$pre_deploy_backup/INCOMPLETE" ]] || fail "pre-deploy backup is incomplete"
[[ -f "$pre_deploy_backup/a446.dump" && -d "$pre_deploy_backup/artifacts" ]] || fail "pre-deploy backup payload is missing"
(cd -- "$pre_deploy_backup" && sha256sum --check SHA256SUMS)
[[ "$(readlink -f "$current_link")" == "$candidate_release" ]] || fail "candidate is not currently active"

previous_release=""
for previous_link in "$(dirname -- "$current_link")"/current.previous-*; do
  [[ -L "$previous_link" ]] || continue
  target="$(readlink -f "$previous_link")"
  if [[ "$target" != "$candidate_release" && "$(dirname -- "$target")" == "$(realpath "$releases_root")" ]]; then
    previous_release="$target"
  fi
done
[[ -n "$previous_release" ]] || fail "could not locate the previous release"
[[ -f "$previous_release/apps/server-hub/src/server-hub-cli.mjs" ]] || fail "previous Server Hub is missing"
[[ -f "$previous_release/apps/web/dist/index.html" ]] || fail "previous Web build is missing"

hub_pid="$(systemctl show a446-server-hub --property MainPID --value)"
[[ "$hub_pid" =~ ^[1-9][0-9]*$ ]] || fail "Server Hub must be running before rehearsal"
node - "$hub_pid" "$runtime_environment" <<'NODE'
const fs = require("node:fs");
const [pid, output] = process.argv.slice(2);
const environment = Object.fromEntries(
  fs.readFileSync(`/proc/${pid}/environ`, "utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
);
for (const name of ["A446_DATABASE_URL", "A446_ARTIFACT_ROOT"]) {
  if (!environment[name]) throw new Error(`Running Server Hub is missing ${name}`);
}
fs.writeFileSync(output, JSON.stringify({
  A446_DATABASE_URL: environment.A446_DATABASE_URL,
  A446_ARTIFACT_ROOT: environment.A446_ARTIFACT_ROOT,
}), { mode: 0o600 });
NODE

mapfile -t database_details < <(node - "$runtime_environment" <<'NODE'
const fs = require("node:fs");
const environment = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const url = new URL(environment.A446_DATABASE_URL);
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("Unsupported database URI");
const host = url.hostname || url.searchParams.get("host") || "";
if (host !== "127.0.0.1" && host !== "localhost" && host !== "/var/run/postgresql") {
  throw new Error("Rehearsal requires a PostgreSQL server on this host");
}
console.log(decodeURIComponent(url.pathname.replace(/^\//, "")));
console.log(decodeURIComponent(url.username));
console.log(environment.A446_ARTIFACT_ROOT);
NODE
)
database_name="${database_details[0]}"
database_role="${database_details[1]}"
artifact_root="$(realpath -m "${database_details[2]}")"
[[ -n "$database_name" && -n "$database_role" ]] || fail "database name and role are required"
[[ "$artifact_root" == /var/lib/a446/* && "$artifact_root" != /var/lib/a446 ]] || fail "Artifact root is outside /var/lib/a446"

artifact_digest() {
  local directory="$1"
  (
    cd -- "$directory"
    find . -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d ' ' -f 1
  )
}

create_pair_backup() {
  local stamp backup_directory database_sha256
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_directory="/var/backups/a446/a446-${stamp}"
  mkdir -m 0700 -- "$backup_directory"
  touch -- "$backup_directory/INCOMPLETE"
  (cd /tmp && sudo -u postgres pg_dump --format=custom --dbname="$database_name") > "$backup_directory/a446.dump"
  mkdir -m 0700 -- "$backup_directory/artifacts"
  cp -a -- "$artifact_root/." "$backup_directory/artifacts/"
  (cd -- "$backup_directory" && sha256sum a446.dump > SHA256SUMS)
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
  created_backup="$backup_directory"
}

restore_active_pair() {
  local backup_directory="$1" stamp target_parent target_name staging rollback
  (cd -- "$backup_directory" && sha256sum --check SHA256SUMS)
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
  target_parent="$(dirname -- "$artifact_root")"
  target_name="$(basename -- "$artifact_root")"
  staging="${target_parent}/.${target_name}.restore-${stamp}"
  rollback="${target_parent}/${target_name}.rollback-${stamp}"
  mkdir -m 0750 -- "$staging"
  cp -a -- "$backup_directory/artifacts/." "$staging/"
  chown -R a446:a446 "$staging"
  if [[ -d "$artifact_root" ]]; then mv -- "$artifact_root" "$rollback"; fi
  mv -- "$staging" "$artifact_root"
  if ! (cd /tmp && sudo -u postgres pg_restore \
    --clean \
    --if-exists \
    --no-owner \
    --role="$database_role" \
    --exit-on-error \
    --single-transaction \
    --dbname="$database_name" \
    "$backup_directory/a446.dump"); then
    mv -- "$artifact_root" "${artifact_root}.failed-${stamp}"
    if [[ -d "$rollback" ]]; then mv -- "$rollback" "$artifact_root"; fi
    return 1
  fi
}

activate_release() {
  local release_directory="$1"
  A446_MAINTENANCE_CONFIRMED=yes \
  A446_SERVICES_STOPPED=yes \
  A446_RELEASES_ROOT="$releases_root" \
  A446_CURRENT_LINK="$current_link" \
  bash "$script_directory/switch-release.sh" "$(basename -- "$release_directory")"
}

run_candidate_migrations() {
  node - "$runtime_environment" "$candidate_release" <<'NODE'
const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const [environmentFile, releaseDirectory] = process.argv.slice(2);
const environment = JSON.parse(fs.readFileSync(environmentFile, "utf8"));
const uid = Number(execFileSync("id", ["-u", "a446"], { encoding: "utf8" }).trim());
const gid = Number(execFileSync("id", ["-g", "a446"], { encoding: "utf8" }).trim());
const result = spawnSync("npm", ["run", "migrate"], {
  cwd: `${releaseDirectory}/apps/server-hub`,
  env: { ...process.env, ...environment },
  stdio: "inherit",
  uid,
  gid,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
NODE
}

start_and_verify() {
  systemctl start a446-server-hub
  local healthy=false
  for attempt in {1..30}; do
    if curl --fail --silent http://127.0.0.1:8787/health >/dev/null; then
      healthy=true
      break
    fi
    sleep 1
  done
  [[ "$healthy" == true ]] || return 1
  node "$script_directory/verify-public-endpoint.mjs" "$public_origin"
}

restore_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
restore_role="a446_restore_${restore_stamp,,}"
restore_database="a446_restore_${restore_stamp,,}"
restore_artifacts="/var/lib/a446/restore-rehearsal-${restore_stamp}"
sudo -u postgres psql --set=ON_ERROR_STOP=1 --command="CREATE ROLE ${restore_role} NOLOGIN"
sudo -u postgres createdb --owner="$restore_role" "$restore_database"
sudo -u postgres pg_restore \
  --no-owner \
  --role="$restore_role" \
  --exit-on-error \
  --single-transaction \
  --dbname="$restore_database" \
  "$pre_deploy_backup/a446.dump"
mkdir -m 0750 -- "$restore_artifacts"
cp -a -- "$pre_deploy_backup/artifacts/." "$restore_artifacts/"
chown -R a446:a446 "$restore_artifacts"
backup_artifact_digest="$(artifact_digest "$pre_deploy_backup/artifacts")"
restore_artifact_digest="$(artifact_digest "$restore_artifacts")"
[[ "$backup_artifact_digest" == "$restore_artifact_digest" ]] || fail "isolated Artifact restore digest differs"
restored_table_count="$(sudo -u postgres psql --dbname="$restore_database" --tuples-only --no-align --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'")"
printf 'ISOLATED RESTORE PASS database=%s tables=%s artifactDigest=%s artifactTarget=%s\n' \
  "$restore_database" "$restored_table_count" "$restore_artifact_digest" "$restore_artifacts"

systemctl stop a446-server-hub
create_pair_backup
candidate_backup="$created_backup"

set +e
(
  set -Eeuo pipefail
  restore_active_pair "$pre_deploy_backup"
  activate_release "$previous_release"
  rsync -a --delete "$previous_release/apps/web/dist/" "$web_root/"
  start_and_verify
)
rollback_status=$?
set -e

systemctl stop a446-server-hub || true
restore_active_pair "$candidate_backup"
activate_release "$candidate_release"
run_candidate_migrations
rsync -a --delete "$candidate_release/apps/web/dist/" "$web_root/"
start_and_verify

[[ "$rollback_status" -eq 0 ]] || fail "previous release verification failed; candidate state was restored"
printf 'VERSION ROLLBACK PASS previous=%s candidate=%s\n' "$previous_release" "$candidate_release"
printf 'FINAL CANDIDATE BACKUP %s\n' "$candidate_backup"
printf 'FINAL ACTIVE RELEASE %s\n' "$(readlink -f "$current_link")"
systemctl is-active a446-server-hub caddy
