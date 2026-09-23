#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
const allowedCommands = new Set(["pg_dump", "pg_restore", "psql"]);
if (!allowedCommands.has(command)) {
  console.error("Usage: run-postgres-client.mjs <pg_dump|pg_restore|psql> [arguments...]");
  process.exit(2);
}

const connectionString = process.env.A446_DATABASE_URL;
if (!connectionString) throw new Error("A446_DATABASE_URL is required");

let url;
try {
  url = new URL(connectionString);
} catch {
  throw new Error("A446_DATABASE_URL must be a PostgreSQL connection URI");
}
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  throw new Error("A446_DATABASE_URL must use the postgresql or postgres scheme");
}

const clientEnvironment = { ...process.env };
delete clientEnvironment.A446_DATABASE_URL;

const parameterEnvironmentNames = {
  application_name: "PGAPPNAME",
  channel_binding: "PGCHANNELBINDING",
  connect_timeout: "PGCONNECT_TIMEOUT",
  dbname: "PGDATABASE",
  gssencmode: "PGGSSENCMODE",
  host: "PGHOST",
  hostaddr: "PGHOSTADDR",
  keepalives: "PGKEEPALIVES",
  keepalives_count: "PGKEEPALIVESCOUNT",
  keepalives_idle: "PGKEEPALIVESIDLE",
  keepalives_interval: "PGKEEPALIVESINTERVAL",
  options: "PGOPTIONS",
  passfile: "PGPASSFILE",
  password: "PGPASSWORD",
  port: "PGPORT",
  require_auth: "PGREQUIREAUTH",
  service: "PGSERVICE",
  servicefile: "PGSERVICEFILE",
  sslcert: "PGSSLCERT",
  sslcompression: "PGSSLCOMPRESSION",
  sslcrl: "PGSSLCRL",
  sslcrldir: "PGSSLCRLDIR",
  sslkey: "PGSSLKEY",
  ssl_max_protocol_version: "PGSSLMAXPROTOCOLVERSION",
  ssl_min_protocol_version: "PGSSLMINPROTOCOLVERSION",
  sslmode: "PGSSLMODE",
  sslpassword: "PGSSLPASSWORD",
  sslrootcert: "PGSSLROOTCERT",
  target_session_attrs: "PGTARGETSESSIONATTRS",
  tcp_user_timeout: "PGTCPUSER_TIMEOUT",
  user: "PGUSER",
};
for (const environmentName of Object.values(parameterEnvironmentNames)) delete clientEnvironment[environmentName];

set("PGHOST", stripIpv6Brackets(decode(url.hostname)));
set("PGPORT", url.port);
set("PGUSER", decode(url.username));
set("PGPASSWORD", decode(url.password));
set("PGDATABASE", decode(url.pathname.replace(/^\//, "")));

for (const [name, value] of url.searchParams) {
  const environmentName = parameterEnvironmentNames[name];
  if (!environmentName) throw new Error(`Unsupported PostgreSQL connection parameter: ${name}`);
  set(environmentName, value);
}
if (!clientEnvironment.PGDATABASE) throw new Error("A446_DATABASE_URL must name a database");

const result = spawnSync(command, args, {
  env: clientEnvironment,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.signal) {
  console.error(`${command} terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

function set(name, value) {
  if (value) clientEnvironment[name] = value;
}

function decode(value) {
  return value ? decodeURIComponent(value) : "";
}

function stripIpv6Brackets(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
