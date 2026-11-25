# Scevia backend foundation

This directory contains Scevia's TypeScript API, PostgreSQL schema, provider adapter contract, fixture adapters, and synchronization pipeline. The configured registry includes a read-only Polymarket public-wallet adapter plus deterministic fixture adapters. Development portfolio authentication remains fixed to one configured principal; production identity, Kalshi, CSV import, trading, and custody are not implemented.

## Local setup

The local database uses PostgreSQL 17 in Docker Compose with a persistent volume. Run these commands from `backend/`.

```bash
cp .env.example .env
npm ci
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

The API listens on `http://127.0.0.1:3001`. Readiness is available at `/readyz`, liveness at `/healthz`, and the OpenAPI page at `/docs`.

`db:seed` creates one **Sample portfolio** for the fixed local development principal and ingests both fixture providers. The seed is repeatable. It does not create live provider connections.

The private API uses the `DEV_AUTH_TOKEN` value in `.env`. Replace the example value with a random token before using the development API. The fixed development principal comes from server configuration. Requests cannot select an owner by sending a user ID header.

```bash
curl http://127.0.0.1:3001/v1/providers
curl -H 'Authorization: Bearer replace-this-with-a-random-value-of-at-least-32-characters' \
  http://127.0.0.1:3001/v1/portfolios
curl -X POST -H 'Authorization: Bearer replace-this-with-a-random-value-of-at-least-32-characters' \
  -H 'Content-Type: application/json' -d '{"name":"Research"}' \
  http://127.0.0.1:3001/v1/portfolios
curl -H 'Authorization: Bearer replace-this-with-a-random-value-of-at-least-32-characters' \
  'http://127.0.0.1:3001/v1/portfolios/00000000-0000-4000-8000-000000000101/positions?limit=50&offset=0'
```

The portfolio endpoints expose positions and cash balances according to provider-declared snapshot semantics, along with historical fills, signed cash movements, settlements, source metadata, entity-specific coverage, and per-stream synchronization history. Financial values are returned as decimal strings. Unavailable fees and marks remain `null` with an explicit status or coverage record. A complete empty snapshot can close current holdings; partial or stale snapshots do not. Polymarket positions use OPEN and CLOSED observations but remain incremental: explicit closed/zero evidence is retained, a newer OPEN row can reopen an instrument, and absence leaves the last-known row marked not seen after the latest successful refresh. Position rows expose `positionState` and `observationStatus`; latest successful observation and latest attempt are separate.

Polymarket positions are exposed as provider observations with provider status/P&L fields. Absence from a response does not close an old position, and retrieval time is not a provider price timestamp. Missing trade metadata is retained as an unresolved activity fact with financial fields and a reason. Activity TRADE observations are retained as overlap candidates rather than duplicate canonical fills. Sync diagnostics distinguish received rows, retained rows, invalid/excluded rows, persisted records, exact duplicates, unresolved records and overlap candidates. See [the Polymarket source mapping and endpoint matrix](docs/POLYMARKET.md).

## Tests and migrations

```bash
npm run check
npm run db:generate -- --name=change-name
npm run db:migrate
```

`npm test` starts an in-memory PostgreSQL-compatible PGlite server when `TEST_DATABASE_URL` is unset. The harness marks the ephemeral connection explicitly before any schema reset. For an external database, destructive tests require `ALLOW_DESTRUCTIVE_TEST_DATABASE=true`, a local PostgreSQL host, and a database name ending in `_test`; `NODE_ENV=production` always rejects the test runner. The CI workflow opts into its disposable PostgreSQL 17 service explicitly. No external provider credentials are needed.

The opt-in `verify:polymarket` script has `connectivity`, `populated`, `repeat` and `market-services` modes. Every mode is local-only and requires `POLYMARKET_LIVE_DATA_AUTHORIZED=YES`; wallet modes also write source/sync data to the selected portfolio and require local development credentials. The guard is an operator attestation, not provider permission. It distinguishes first-page API readback from total history and requires complete stream execution for success; populated mode also requires retained/persisted records and selected-source API readback, while repeat mode requires exact duplicate evidence. Do not run it until the intended data use is permitted. See [provider limitations and legal scope](docs/POLYMARKET.md).

The migration runner applies the versioned SQL files under `drizzle/`. Schema changes are generated from `src/db/schema.ts` and committed as SQL; migrations that add required snapshot ownership backfill existing observations before adding constraints. Tests drop and recreate the application schema only after the target database passes the safety checks. The fixture seed is restricted to a local `scevia` or `scevia_test` database (or an explicitly allowed `_dev` database) and is disabled in production.

The checked-in `.env.example` contains local-only placeholders. Keep real credentials in `.env`, which is ignored by Git. Database dumps, including `scevia-backup*.sql`, are ignored as well.

## API outline

| Method and path | Access | Purpose |
|---|---|---|
| `GET /healthz` | Public | Process liveness |
| `GET /readyz` | Public | Database readiness |
| `GET /v1/providers` | Public | Provider capabilities |
| `GET /v1/portfolios` | Authenticated | Portfolios for the configured principal |
| `POST /v1/portfolios` | Authenticated | Create a development portfolio for the configured principal |
| `GET /v1/portfolios/{id}/sources` | Authenticated | Provider source labels and types |
| `POST /v1/portfolios/{id}/sources/polymarket` | Authenticated | Register an explicitly supplied public account wallet |
| `GET /v1/portfolios/{id}/positions` | Authenticated | Latest stored provider position observations, with source-specific freshness limits |
| `GET /v1/portfolios/{id}/fills` | Authenticated | Fill history and fee coverage |
| `GET /v1/portfolios/{id}/activity-facts` | Authenticated | Typed activity not reconciled to canonical financial records |
| `GET /v1/portfolios/{id}/cash-movements` | Authenticated | Signed deposits, withdrawals, transfers, and adjustments |
| `GET /v1/portfolios/{id}/settlements` | Authenticated | Settlement facts and payouts |
| `GET /v1/portfolios/{id}/cash-balances` | Authenticated | Current reported balances from finalized snapshots |
| `GET /v1/portfolios/{id}/coverage` | Authenticated | Observed ranges, provider-reported outer coverage bounds, source and snapshot watermarks, attempt state, and latest successful entity retrieval |
| `GET /v1/portfolios/{id}/sync-runs` | Authenticated | Recent stream runs with cursor and snapshot-completion state |
| `POST /v1/provider-accounts/{id}/sync` | Authenticated | Bounded read-only synchronization across configured streams |
| `GET /v1/market-data/search?q=...&limit=...&page=...` | Public | Account-independent paginated event/market lookup with continuation and truncation state |
| `POST /v1/market-data/resolve` | Public | Resolve supported Polymarket event or market links through trusted APIs |
| `GET /v1/market-data/prices-history?tokenId=...` | Public | Bounded provider price-history points |

List endpoints accept `limit` from 1 to 100 and `offset` from 0 to 100000; private financial list endpoints optionally accept `providerAccountId` to scope readback to one selected source within the owned portfolio. The source ID may be returned on those private rows for scoped client use. Market search accepts `limit` from 1 to 10 and `page` from 1 to 100. Errors use a stable code and request ID. Raw source payloads are never returned by the API.

The sync response is an account-level summary with a result for each stream. Ordinary interrupted streams can resume from a committed pagination cursor; complete authoritative snapshot streams restart from page one so all published pages belong to one run. Provider checkpoints are stored independently and passed to later incremental runs. Coverage bounds are an envelope and do not prove continuity across gaps. Sync is synchronous in this phase, limited to 500 records per page, 10,000 records per stream, 100 pages, and 25 seconds per account request. The time budget is shared across configured streams so one large history backfill can resume without preventing later streams from progressing. A production provider that cannot fit these bounds will need a background job interface before launch.

## Runtime and security boundary

The application requires Node.js 24. Development bearer authentication is rejected when `NODE_ENV=production`. `AUTH_MODE=external` also fails startup until a production principal resolver is implemented. Production configuration requires database TLS and explicit CORS origins.

This phase does not store provider credentials. Future integrations should use public read-only wallet data or least-privilege read scopes. Never provide a private key, seed phrase, trading permission, or withdrawal permission to Scevia.

The API is a backend foundation, not a production-ready authentication service. Source payloads and private financial records are stored in plaintext for backend processing; there is no user-facing retention, export, or deletion workflow. These trust boundaries and the planned user-controlled source model are documented in [the architecture and threat model](docs/ARCHITECTURE.md) and [frontend integration notes](docs/FRONTEND_INTEGRATION.md).

The live Polymarket HTTP integration defaults to disabled. Enable it only for permitted local development on a loopback bind by setting `POLYMARKET_LIVE_DATA_AUTHORIZED=YES` in the server environment. This setting records an operator decision and does not grant data-use rights. Fixture adapters and injected contract-test transports work without live access.

See [Accounting](docs/ACCOUNTING.md) for the source-independent CSV format, import workflow, weighted-average replay and Phase 3 scope.
