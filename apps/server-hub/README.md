# A446 Server Hub

This package is the PostgreSQL-backed single-process control plane for v0.5 Server Ready. The current `0.5.0-alpha.3` build includes durable scheduling, Attempt/Lease recovery, independent Worker and Web identities, minimal RBAC, a local central Artifact Store, refreshable resource snapshots, and restart-safe human interventions.

## Server configuration

Keep the database URL, passwords, Worker credentials, and Artifact Store location out of JSON and source control:

```powershell
$env:A446_DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/DATABASE'
$env:A446_ARTIFACT_ROOT = 'D:\A446-Data\artifacts'
```

`A446_ARTIFACT_ROOT` must be an absolute directory outside this repository. The server creates opaque object keys beneath it; Worker paths and original filenames are metadata only and never become server storage paths. The default single-file limit is 100 MiB.

Migrations run automatically at startup and can also be applied explicitly:

```powershell
npm.cmd run migrate
npm.cmd start
```

Place the loopback listener behind an HTTPS/WSS reverse proxy. Formal Server Hub configuration uses `auth.mode=identity` and rejects the old shared `HUB_TOKEN` mechanism. The local Mock Hub retains Legacy Token mode for trusted development only.

Set `auth.allowedOrigins` to the exact public HTTPS origin used by the Web console. This lets CSRF origin checks remain strict when a loopback Server Hub sits behind a reverse proxy or the Vite development proxy.

## Bootstrap identities

Create the first administrator with a password passed through a temporary environment variable:

```powershell
$env:A446_BOOTSTRAP_PASSWORD = 'use-a-long-unique-password'
npm.cmd run identity -- create-user --config config/server.example.json --username admin --role admin --password-env A446_BOOTSTRAP_PASSWORD
Remove-Item Env:A446_BOOTSTRAP_PASSWORD
```

Create an operator in the same way with `--role operator`. Passwords are stored using Node.js `scrypt`; plaintext passwords are not persisted.

Create a Worker credential:

```powershell
npm.cmd run identity -- create-worker --config config/server.example.json --agent-id worker-01 --device-id device-01
```

The command prints the Worker token once. Put it in `A446_WORKER_TOKEN` on that Worker and use [worker.example.json](config/worker.example.json). Each token is bound to one `agentId` and `deviceId`; the server rejects mismatched `worker.hello` claims.

Credential administration commands:

```powershell
npm.cmd run identity -- list-workers --config config/server.example.json
npm.cmd run identity -- rotate-worker --config config/server.example.json --credential-id UUID
npm.cmd run identity -- revoke-worker --config config/server.example.json --credential-id UUID
```

Rotation prints a new token once and revokes the old credential. The Web API exposes the same operations to administrators; operators cannot manage identities, approve tasks, cancel tasks, or control Worker state.

## Web authentication and artifacts

Web users sign in through `POST /v1/auth/login`. The server uses an opaque server-side session, an `HttpOnly; Secure; SameSite=Strict` cookie, and a CSRF token for mutations. Browser requests no longer receive or proxy a shared Hub token.

Workers stream declared outputs to the server. The server writes a temporary file, verifies declared size and SHA-256, and atomically moves valid content into the Artifact Store. A result is accepted only when every Task Spec output points to matching `ready` metadata. Review Workers stream authorized references into their own allowed workspace and verify size and SHA-256 before execution.

## Resource refresh and human recovery

Workers run their adapter, configured tool, device, model, and trusted quota probes at startup and then at the low-frequency interval configured by `capabilityProbe.intervalMs`. Each section reports its source, probe time, last successful time, stale state, and a bounded error summary. A failed refresh keeps the last trusted value marked `stale`; it does not take the Worker offline. Model discovery can use a configured machine-readable `modelProbe`; otherwise the configured model list remains visible with `source=config` and unknown availability. Numeric quota data is accepted only from `quotaProbe` JSON, and remains `Unknown` when no trusted source exists.

Human requests are stored independently in `human_interventions`, not only inside a task document. `GET /v1/interventions?status=pending` lists pending work. `POST /v1/interventions/{id}/resolve` accepts one `approve`, `reject`, or `respond` decision as allowed by the record. PostgreSQL conditionally updates only a pending record, so repeat or concurrent submissions return `409`. Workflow replies resume from the recorded role, stage, parent task, and `sessionScopeId`; retry approval remains administrator-only.

## PostgreSQL integration test

Use a dedicated disposable database:

```powershell
$env:A446_TEST_DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/a446_test'
npm.cmd run test:postgres
```

The tests truncate all A446 tables in that database. Never point them at a database containing data that must be preserved.

## Operations and release preparation

See [OPERATIONS.md](OPERATIONS.md) for the minimal startup order, environment-variable boundary, TLS/WSS reverse-proxy requirements, coordinated PostgreSQL/Artifact backup and recovery, and release-package checklist. The non-secret variable names are collected in [.env.example](.env.example); it is documentation only and is not loaded automatically.
