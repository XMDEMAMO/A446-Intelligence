#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This launcher pins the already-tested application candidate. It lives on
# an operations branch so adding the launcher does not change that candidate.
release_sha=a762204e0ab3f2404e4862de04f066a9074b6173
source_ref=codex/staging-integration-20261010
public_origin=https://staging.a446intelligence.party
app_root=/srv/a446/app
current_link=/srv/a446/current

fail() {
  printf 'VNC deployment stopped: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail 'Run this launcher from the server root console.'
for name in bash git sudo tar mktemp node curl systemctl readlink df free; do
  command -v "$name" >/dev/null 2>&1 || fail "Missing command: $name"
done
[[ -d "$app_root/.git" ]] || fail 'The existing A446 checkout is missing.'
[[ -L "$current_link" && -d "$current_link" ]] || fail 'The active release link is missing or invalid.'
systemctl is-active --quiet a446-server-hub || fail 'Server Hub is not healthy; repair it before upgrading.'
systemctl is-active --quiet caddy || fail 'Caddy is not running.'
curl --fail --silent --show-error http://127.0.0.1:8787/health >/dev/null

current_release="$(readlink -f "$current_link")"
printf 'Current release: %s\nCandidate: %s\n' "$current_release" "$release_sha"
free -h
df -h /srv/a446 /var/lib/a446 /var/backups

if [[ -f "$current_release/RELEASE_SHA" ]] && [[ "$(cat "$current_release/RELEASE_SHA")" == "$release_sha" ]]; then
  node "$current_release/scripts/deploy/verify-public-endpoint.mjs" "$public_origin"
  printf 'VERIFIED RELEASE: %s (already deployed)\n' "$release_sha"
  exit 0
fi
[[ ! -e "/srv/a446/releases/$release_sha" ]] || fail 'A previous deployment attempt already prepared this release. Preserve it and review the previous output before retrying.'

# Inspect only the count of in-flight work. Application credentials stay
# inside this server-side process and never enter command arguments or logs.
hub_pid="$(systemctl show a446-server-hub --property MainPID --value)"
[[ "$hub_pid" =~ ^[1-9][0-9]*$ ]] || fail 'Could not identify the running Server Hub.'
node - "$hub_pid" "$current_release" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [pid, release] = process.argv.slice(2);
const environment = Object.fromEntries(
  fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }),
);
if (!environment.A446_DATABASE_URL) throw new Error("Running Hub has no configured database.");
const { Pool } = require(path.join(release, "apps/server-hub/node_modules/pg"));
const pool = new Pool({ connectionString: environment.A446_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
(async () => {
  try {
    const result = await pool.query("SELECT count(*)::int AS count FROM tasks WHERE status IN ('dispatched', 'running', 'processing_result')");
    const count = result.rows[0].count;
    console.log(`In-flight tasks: ${count}`);
    if (count > 0) throw new Error("Wait for the in-flight tasks to finish before deploying.");
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE

sudo -u a446 -H git -C "$app_root" fetch --no-tags origin "$source_ref"
fetched_sha="$(sudo -u a446 -H git -C "$app_root" rev-parse FETCH_HEAD)"
[[ "$fetched_sha" == "$release_sha" ]] || fail "Fetched commit does not match the tested candidate: $fetched_sha"

stage_dir="$(mktemp -d /var/tmp/a446-vnc-deploy.XXXXXX)"
sudo -u a446 -H git -C "$app_root" archive "$release_sha" scripts/deploy | tar -x -C "$stage_dir"
printf 'Starting paired backup, build, migration and deployment. Keep this console open.\n'
bash "$stage_dir/scripts/deploy/upgrade-staging-v05.sh" "$release_sha" "$source_ref" "$public_origin"

[[ "$(cat "$current_link/RELEASE_SHA")" == "$release_sha" ]] || fail 'The active release marker does not match the candidate.'
systemctl is-active --quiet a446-server-hub || fail 'Server Hub did not start.'
systemctl is-active --quiet caddy || fail 'Caddy did not stay active.'
node "$current_link/scripts/deploy/verify-public-endpoint.mjs" "$public_origin"
printf 'VERIFIED RELEASE: %s\n' "$release_sha"
