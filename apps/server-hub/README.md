# A446 Server Hub

This package is the PostgreSQL-backed single-process control plane for the v0.5 Server Ready milestone. It reuses the existing Agent Hub protocol and orchestration code while keeping PostgreSQL out of the local Worker runtime dependencies.

## Configuration

Set secrets in the process environment, not in JSON:

```powershell
$env:A446_DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/DATABASE'
$env:HUB_TOKEN = 'replace-with-a-random-secret'
```

Run migrations:

```powershell
npm.cmd run migrate
```

Start the server behind a TLS reverse proxy:

```powershell
npm.cmd start
```

The example binds to loopback so the reverse proxy can terminate HTTPS and WSS. The shared `HUB_TOKEN` remains a temporary batch-one compatibility mechanism and will be replaced by independent Worker and Web identities in batch two.

Lease recovery defaults to a 30-second TTL, a 5-second scan interval, and at most three automatic recovery attempts. Only Task Specs that explicitly declare `side_effects` as `none` or `idempotent` are eligible for automatic recovery; all other cases stop for human approval.

## PostgreSQL integration test

Use a dedicated disposable database:

```powershell
$env:A446_TEST_DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/a446_test'
npm.cmd run test:postgres
```

The test truncates A446 tables in that database. Never point it at a database containing data that must be preserved.
