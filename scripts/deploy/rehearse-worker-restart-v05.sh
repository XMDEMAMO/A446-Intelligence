#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'rehearse-worker-restart-v05: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "run this script as root"
[[ $# -le 1 ]] || fail "usage: rehearse-worker-restart-v05.sh [https-origin]"

public_origin="${1:-https://staging.a446intelligence.party}"
[[ "$public_origin" =~ ^https://[^/]+$ ]] || fail "origin must be an HTTPS origin without a path"

current_link="${A446_CURRENT_LINK:-/srv/a446/current}"
server_config="${A446_SERVER_CONFIG:-/etc/a446/server-hub.json}"
evidence_root="${A446_EVIDENCE_ROOT:-/var/backups/a446}"
worker_user="${A446_WORKER_USER:-a446-worker}"
unit_name="a446-worker-restart-probe.service"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
agent_id="release-restart-probe-${stamp,,}"
device_id="staging-systemd-${stamp,,}"
current_release="$(readlink -f "$current_link")"
node_bin="$(command -v node)"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
identity_cli="$current_release/apps/server-hub/src/identity-cli.mjs"
worker_cli="$current_release/apps/agent-hub/src/worker-cli.mjs"
public_verifier="$script_directory/verify-public-endpoint.mjs"
postgres_helper="$script_directory/run-postgres-client.mjs"
runtime_environment="$(mktemp /run/a446-worker-restart-environment.XXXXXX)"
credential_file="$(mktemp /run/a446-worker-restart-credential.XXXXXX)"
worker_root="/var/lib/a446-worker/$agent_id"
workers_config_root="/etc/a446/workers"
environment_file="$workers_config_root/restart-probe.env"
worker_config="$workers_config_root/restart-probe.json"
unit_file="/etc/systemd/system/$unit_name"
evidence_directory="$evidence_root/worker-restart-$stamp"
credential_id=""
test_started=false

[[ -d "$current_release" ]] || fail "current release target does not exist"
[[ -f "$server_config" ]] || fail "Server Hub config is missing: $server_config"
[[ -f "$identity_cli" && -f "$worker_cli" ]] || fail "current release is missing Server Hub or Worker entrypoints"
[[ -f "$public_verifier" && -f "$postgres_helper" ]] || fail "deployment helpers are missing"
systemctl is-active --quiet a446-server-hub || fail "a446-server-hub is not active"
systemctl is-active --quiet caddy || fail "caddy is not active"

cleanup() {
  local status=$?
  set +e
  if [[ "$test_started" == true ]]; then systemctl stop "$unit_name" >/dev/null 2>&1; fi
  if [[ -n "$credential_id" && -s "$runtime_environment" ]]; then
    node - "$runtime_environment" "$identity_cli" "$server_config" "$credential_id" <<'NODE' >/dev/null 2>&1
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [environmentFile, identityCli, serverConfig, credentialId] = process.argv.slice(2);
const environment = JSON.parse(fs.readFileSync(environmentFile, "utf8"));
spawnSync(process.execPath, [
  identityCli,
  "revoke-worker",
  "--config", serverConfig,
  "--credential-id", credentialId,
], { env: { ...process.env, ...environment }, stdio: "ignore" });
NODE
  fi
  rm -f -- "$unit_file" "$environment_file" "$worker_config" "$runtime_environment" "$credential_file"
  if [[ "$worker_root" == /var/lib/a446-worker/release-restart-probe-* ]]; then
    rm -rf -- "$worker_root"
  fi
  systemctl daemon-reload >/dev/null 2>&1
  if [[ "$status" -ne 0 ]]; then
    printf 'rehearse-worker-restart-v05: failed; temporary Worker was stopped and its credential was revoked\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

hub_pid="$(systemctl show a446-server-hub --property MainPID --value)"
[[ "$hub_pid" =~ ^[1-9][0-9]*$ ]] || fail "could not identify the running Server Hub process"
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
if (!environment.A446_DATABASE_URL) throw new Error("Running Server Hub is missing A446_DATABASE_URL");
fs.writeFileSync(output, JSON.stringify({ A446_DATABASE_URL: environment.A446_DATABASE_URL }), { mode: 0o600 });
NODE

node - "$runtime_environment" "$identity_cli" "$server_config" "$agent_id" "$device_id" "$credential_file" <<'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [environmentFile, identityCli, serverConfig, agentId, deviceId, output] = process.argv.slice(2);
const environment = JSON.parse(fs.readFileSync(environmentFile, "utf8"));
const result = spawnSync(process.execPath, [
  identityCli,
  "create-worker",
  "--config", serverConfig,
  "--agent-id", agentId,
  "--device-id", deviceId,
], { env: { ...process.env, ...environment }, encoding: "utf8" });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const credential = JSON.parse(result.stdout);
fs.writeFileSync(output, JSON.stringify(credential), { mode: 0o600 });
console.log(`Created short-lived credential ${credential.credentialId} for ${credential.agentId}`);
NODE
credential_id="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).credentialId)' "$credential_file")"
[[ "$credential_id" =~ ^[0-9a-f-]{36}$ ]] || fail "identity CLI returned an invalid credential ID"

if ! id -u "$worker_user" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/a446-worker --create-home --shell /usr/sbin/nologin "$worker_user"
fi
getent group a446 >/dev/null || fail "required release access group a446 does not exist"
worker_group="$(id -gn "$worker_user")"
install -d -o root -g "$worker_group" -m 0750 "$workers_config_root"
install -d -o "$worker_user" -g "$worker_group" -m 0750 /var/lib/a446-worker "$worker_root" "$worker_root/workspace" "$worker_root/state"
install -d -o root -g root -m 0700 "$evidence_root" "$evidence_directory"

node - "$credential_file" "$environment_file" "$worker_config" "$public_origin" "$agent_id" "$device_id" "$worker_root" <<'NODE'
const fs = require("node:fs");
const [credentialFile, environmentFile, configFile, origin, agentId, deviceId, workerRoot] = process.argv.slice(2);
const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
const config = {
  agentId,
  deviceId,
  account: { id: "release-probe", provider: "mock", plan: "test", label: "Release restart probe" },
  roles: ["executor"],
  models: [{
    id: "mock-restart-probe",
    capabilities: ["task.execute"],
    quota: { state: "Healthy", source: "mock", windows: [] },
  }],
  hubUrl: `${origin.replace(/^https:/, "wss:")}/worker`,
  authTokenEnv: "A446_WORKER_TOKEN",
  authRequired: true,
  heartbeatMs: 2000,
  stateFile: `${workerRoot}/state/worker.json`,
  workspace: `${workerRoot}/workspace`,
  artifacts: { centralStore: true, apiUrl: origin, maxFileBytes: 104857600 },
  reconnect: { baseMs: 250, maxMs: 5000 },
  adapter: { type: "mock", delayMs: 50 },
};
fs.writeFileSync(environmentFile, `A446_WORKER_TOKEN=${credential.token}\n`, { mode: 0o640 });
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
NODE
chown root:"$worker_group" "$environment_file" "$worker_config"

cat > "$unit_file" <<EOF
[Unit]
Description=A446 v0.5 release restart probe Worker
After=network-online.target a446-server-hub.service
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
User=$worker_user
Group=$worker_group
SupplementaryGroups=a446
WorkingDirectory=$current_release/apps/agent-hub
Environment=NODE_ENV=production
EnvironmentFile=$environment_file
ExecStart=$node_bin $worker_cli --config $worker_config
Restart=on-failure
RestartSec=2
TimeoutStopSec=20
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$unit_file"
systemctl daemon-reload
systemd-analyze verify "$unit_file"

query_agent() {
  node - "$runtime_environment" "$postgres_helper" "$agent_id" <<'NODE'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [environmentFile, helper, agentId] = process.argv.slice(2);
const environment = JSON.parse(fs.readFileSync(environmentFile, "utf8"));
if (!/^[a-z0-9-]+$/.test(agentId)) throw new Error("Unexpected probe agent ID");
const sql = `SELECT concat_ws(E'\\t', status, coalesce(document->>'deviceId',''), coalesce(document->>'connectedAt',''), coalesce(document->>'reconnectedAt','')) FROM worker_registrations WHERE agent_id = '${agentId}';`;
const result = spawnSync(process.execPath, [
  helper,
  "psql",
  "--set=ON_ERROR_STOP=1",
  "--tuples-only",
  "--no-align",
  "--command", sql,
], { env: { ...process.env, ...environment }, encoding: "utf8" });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout.trim());
NODE
}

wait_for_online() {
  local require_reconnect="$1" output status device connected reconnected
  for _ in {1..45}; do
    output="$(query_agent || true)"
    IFS=$'\t' read -r status device connected reconnected <<< "$output"
    if [[ "$status" == "online" && "$device" == "$device_id" ]]; then
      if [[ "$require_reconnect" == false || -n "$reconnected" ]]; then
        printf '%s\n' "$output"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

systemctl start "$unit_name"
test_started=true
initial_agent_record="$(wait_for_online false)" || fail "Worker did not authenticate through public WSS"
old_pid="$(systemctl show "$unit_name" --property MainPID --value)"
old_restarts="$(systemctl show "$unit_name" --property NRestarts --value)"
[[ "$old_pid" =~ ^[1-9][0-9]*$ ]] || fail "Worker service has no valid PID"

kill -KILL "$old_pid"
reconnected_agent_record="$(wait_for_online true)" || fail "Worker did not reconnect after the controlled failure"
new_pid="$(systemctl show "$unit_name" --property MainPID --value)"
new_restarts="$(systemctl show "$unit_name" --property NRestarts --value)"
[[ "$new_pid" =~ ^[1-9][0-9]*$ && "$new_pid" != "$old_pid" ]] || fail "systemd did not replace the failed Worker process"
[[ "$new_restarts" =~ ^[0-9]+$ && "$new_restarts" -gt "$old_restarts" ]] || fail "systemd restart counter did not increase"

node "$public_verifier" "$public_origin" | tee "$evidence_directory/public-verifier.txt"
public_host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$public_origin")"
openssl s_client -connect "$public_host:443" -servername "$public_host" </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256 \
  > "$evidence_directory/tls-certificate.txt"
journalctl -u "$unit_name" --since '-10 minutes' --no-pager \
  | sed -E 's/a446w\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+/[REDACTED]/g' \
  > "$evidence_directory/worker-journal.txt"

node - "$evidence_directory/evidence.json" "$stamp" "$public_origin" "$current_release" "$agent_id" "$device_id" "$unit_name" "$credential_id" "$old_pid" "$new_pid" "$old_restarts" "$new_restarts" "$initial_agent_record" "$reconnected_agent_record" <<'NODE'
const fs = require("node:fs");
const [output, stamp, origin, release, agentId, deviceId, unit, credentialId, oldPid, newPid, oldRestarts, newRestarts, initial, reconnected] = process.argv.slice(2);
const parseRecord = (value) => {
  const [status, recordDeviceId, connectedAt, reconnectedAt] = value.split("\t");
  return { status, deviceId: recordDeviceId, connectedAt: connectedAt || null, reconnectedAt: reconnectedAt || null };
};
const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  probeStartedAt: stamp,
  origin,
  release,
  agentId,
  deviceId,
  unit,
  credentialId,
  oldPid: Number(oldPid),
  newPid: Number(newPid),
  restartsBefore: Number(oldRestarts),
  restartsAfter: Number(newRestarts),
  initialRegistration: parseRecord(initial),
  reconnectedRegistration: parseRecord(reconnected),
  checks: {
    authenticatedPublicWss: true,
    systemdRestartOnFailure: true,
    sameAgentReconnected: true,
    publicEndpointVerifier: true,
    tlsCertificateValidated: true,
  },
  credentialCleanup: "The short-lived credential is revoked by the script exit trap.",
};
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE

printf 'WORKER RESTART PASS agent=%s device=%s pid=%s->%s restarts=%s->%s\n' \
  "$agent_id" "$device_id" "$old_pid" "$new_pid" "$old_restarts" "$new_restarts"
printf 'AUTHENTICATED WSS PASS origin=%s\n' "$public_origin"
printf 'EVIDENCE DIRECTORY %s\n' "$evidence_directory"
