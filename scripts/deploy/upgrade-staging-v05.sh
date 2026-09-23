#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

fail() {
  printf 'upgrade-staging-v05: %s\n' "$*" >&2
  exit 1
}

[[ $# -ge 1 && $# -le 3 ]] || fail "usage: upgrade-staging-v05.sh <release-sha> [source-ref] [https-origin]"

release_sha="$1"
source_ref="${2:-codex/v05-parallel-integration}"
public_origin="${3:-https://staging.a446intelligence.party}"
public_host="${public_origin#https://}"
app_root="${A446_APP_ROOT:-/srv/a446/app}"
releases_root="${A446_RELEASES_ROOT:-/srv/a446/releases}"
current_link="${A446_CURRENT_LINK:-/srv/a446/current}"
release_directory="${releases_root}/${release_sha}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
config_backup="/var/backups/a446/config-${stamp}"
new_unit="${config_backup}/a446-server-hub.service.new"
new_caddyfile="${config_backup}/Caddyfile.new"

[[ "$(id -u)" -eq 0 ]] || fail "run this script as root"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || fail "release SHA must contain exactly 40 lowercase hexadecimal characters"
[[ "$public_origin" == https://* ]] || fail "public origin must use HTTPS"
[[ "$public_host" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || fail "public origin must contain only a host and optional port"
for name in git node npm sudo rsync tar caddy curl pg_dump sha256sum realpath; do
  command -v "$name" >/dev/null 2>&1 || fail "missing command: $name"
done
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$node_major" -ge 20 ]] || fail "Node.js 20 or newer is required"
[[ -d "$app_root/.git" ]] || fail "$app_root is not a Git checkout"
[[ -f /etc/a446/server-hub.env ]] || fail "missing /etc/a446/server-hub.env"
[[ ! -e "$release_directory" && ! -L "$release_directory" ]] || fail "release already exists: $release_directory"
if [[ -e "$current_link" && ! -L "$current_link" ]]; then
  fail "$current_link exists but is not a symbolic link"
fi

install -d -o root -g root -m 0700 /var/backups/a446 "$config_backup"
cp -a /etc/a446/server-hub.env "$config_backup/"
cp -a /etc/caddy/Caddyfile "$config_backup/"
cp -a /etc/systemd/system/a446-server-hub.service "$config_backup/"
if [[ -f /etc/a446/server-hub.json ]]; then
  cp -a /etc/a446/server-hub.json "$config_backup/"
elif [[ -f "$app_root/apps/server-hub/config/server.staging.json" ]]; then
  install -o root -g a446 -m 0640 "$app_root/apps/server-hub/config/server.staging.json" /etc/a446/server-hub.json
else
  fail "could not find the active Server Hub JSON config"
fi

node - /etc/a446/server-hub.json "$public_origin" <<'NODE'
const fs = require("node:fs");
const [path, origin] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.auth ??= {};
config.auth.allowedOrigins = [origin];
config.auth.trustedProxyIps = ["127.0.0.1/32", "::1/128"];
config.logs ??= {};
config.logs.file = "/var/log/a446/server-hub-events.jsonl";
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
NODE
chown root:a446 /etc/a446/server-hub.json
chmod 0640 /etc/a446/server-hub.json

sudo -u a446 -H git -C "$app_root" fetch --force --no-tags origin "$source_ref"
fetched_sha="$(sudo -u a446 -H git -C "$app_root" rev-parse FETCH_HEAD)"
[[ "$fetched_sha" == "$release_sha" ]] || fail "fetched $fetched_sha, expected $release_sha"

install -d -o a446 -g a446 -m 0755 "$releases_root" "$release_directory"
sudo -u a446 -H git -C "$app_root" archive "$release_sha" | sudo -u a446 -H tar -x -C "$release_directory"
printf '%s\n' "$release_sha" > "$release_directory/RELEASE_SHA"
chown a446:a446 "$release_directory/RELEASE_SHA"

sudo -u a446 -H bash -c '
  set -euo pipefail
  cd "$1/apps/agent-hub"
  npm ci --omit=dev
  cd "$1/apps/server-hub"
  npm ci --omit=dev
  cd "$1/apps/web"
  npm ci
  npm run build
' bash "$release_directory"

if [[ -L "$current_link" ]]; then
  previous_release="$(readlink -f "$current_link")"
else
  previous_release="${releases_root}/pre-${stamp}"
  install -d -o a446 -g a446 -m 0755 "$previous_release"
  rsync -a --exclude='.git/' "$app_root/" "$previous_release/"
  chown -R a446:a446 "$previous_release"
  [[ -f "$previous_release/apps/server-hub/src/server-hub-cli.mjs" ]] || fail "previous release snapshot is incomplete"
  [[ -f "$previous_release/apps/web/dist/index.html" ]] || fail "previous Web build is missing"
  ln -s "$previous_release" "$current_link"
fi

node_bin="$(command -v node)"
sed "s#/usr/bin/node#$node_bin#" "$release_directory/deploy/systemd/a446-server-hub.service.example" > "$new_unit"
sed \
  -e "1s|.*|${public_host} {|" \
  -e 's#/srv/a446/current/apps/web/dist#/var/www/a446-staging#g' \
  -e 's/# Strict-Transport-Security "max-age=31536000; includeSubDomains"/Strict-Transport-Security "max-age=31536000"/' \
  "$release_directory/deploy/Caddyfile.example" > "$new_caddyfile"
caddy validate --config "$new_caddyfile"

systemctl stop a446-server-hub
[[ "$(systemctl is-active a446-server-hub || true)" != "active" ]] || fail "Server Hub did not stop"

set -a
. /etc/a446/server-hub.env
set +a
export A446_MAINTENANCE_CONFIRMED=yes
bash "$release_directory/scripts/deploy/backup-server.sh" /var/backups/a446

export A446_SERVICES_STOPPED=yes
bash "$release_directory/scripts/deploy/switch-release.sh" "$release_sha"
unset A446_SERVICES_STOPPED A446_MAINTENANCE_CONFIRMED

sudo -u a446 -H bash -c '
  set -euo pipefail
  set -a
  . /etc/a446/server-hub.env
  set +a
  cd "$1/apps/server-hub"
  npm run migrate
' bash "$release_directory"

install -o root -g root -m 0644 "$new_unit" /etc/systemd/system/a446-server-hub.service
install -o root -g root -m 0644 "$new_caddyfile" /etc/caddy/Caddyfile
rsync -a --delete "$release_directory/apps/web/dist/" /var/www/a446-staging/
systemctl daemon-reload
systemctl start a446-server-hub
systemctl reload caddy

healthy=false
for attempt in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:8787/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]] || fail "Server Hub health check failed"
node "$release_directory/scripts/deploy/verify-public-endpoint.mjs" "$public_origin"

printf 'DEPLOYMENT COMPLETE\n'
printf 'Candidate: %s\n' "$release_directory"
printf 'Previous:  %s\n' "$previous_release"
printf 'Config backup: %s\n' "$config_backup"
readlink -f "$current_link"
systemctl is-active a446-server-hub caddy
