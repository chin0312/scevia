# Scevia backend foundation

This directory contains Scevia's TypeScript API, PostgreSQL schema, provider adapter contract, fixture adapters, and synchronization pipeline. The only configured providers are deterministic fixtures. There is no Polymarket or Kalshi production adapter, user login flow, trading endpoint, or custody function.

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
curl -H 'Authorization: Bearer replace-this-with-a-random-value-of-at-least-32-characters' \
  'http://127.0.0.1:3001/v1/portfolios/00000000-0000-4000-8000-000000000101/positions?limit=50&offset=0'
```

The portfolio endpoints expose stored positions, fills, signed cash movements, settlements, cash balances, source metadata, coverage, and synchronization history. Financial values are returned as decimal strings. Unavailable fees and marks remain `null` with an explicit status or coverage record.

## Tests and migrations

```bash
npm run check
npm run db:generate -- --name=change-name
npm run db:migrate
```

`npm test` starts an in-memory PostgreSQL-compatible PGlite server when `TEST_DATABASE_URL` is unset. The CI workflow sets `TEST_DATABASE_URL` to a clean PostgreSQL 17 service, so the same integration suite also runs against PostgreSQL. No external provider credentials are needed.

The migration runner applies the versioned SQL files under `drizzle/`. Schema changes are generated from `src/db/schema.ts` and committed as SQL. Tests drop and recreate the application schema before applying the migrations.

## API outline

| Method and path | Access | Purpose |
|---|---|---|
| `GET /healthz` | Public | Process liveness |
| `GET /readyz` | Public | Database readiness |
| `GET /v1/providers` | Public | Provider capabilities |
| `GET /v1/portfolios` | Authenticated | Portfolios for the configured principal |
| `GET /v1/portfolios/{id}/sources` | Authenticated | Provider source labels and types |
| `GET /v1/portfolios/{id}/positions` | Authenticated | Latest position snapshots |
| `GET /v1/portfolios/{id}/fills` | Authenticated | Fill history and fee coverage |
| `GET /v1/portfolios/{id}/cash-movements` | Authenticated | Signed deposits, withdrawals, transfers, and adjustments |
| `GET /v1/portfolios/{id}/settlements` | Authenticated | Settlement facts and payouts |
| `GET /v1/portfolios/{id}/cash-balances` | Authenticated | Latest reported cash balances |
| `GET /v1/portfolios/{id}/coverage` | Authenticated | Data availability and freshness |
| `GET /v1/portfolios/{id}/sync-runs` | Authenticated | Recent synchronization state |
| `POST /v1/provider-accounts/{id}/sync` | Authenticated | Bounded read-only fixture synchronization |

List endpoints accept `limit` from 1 to 100 and `offset` from 0 to 100000. Errors use a stable code and request ID. Raw source payloads and provider account identifiers are not returned by the API.

## Runtime and security boundary

The application requires Node.js 24. Development bearer authentication is rejected when `NODE_ENV=production`. `AUTH_MODE=external` also fails startup until a production principal resolver is implemented. Production configuration requires database TLS and explicit CORS origins.

This phase does not store provider credentials. Future integrations should use public read-only wallet data or least-privilege read scopes. Never provide a private key, seed phrase, trading permission, or withdrawal permission to Scevia.

The API is a backend foundation, not a production-ready authentication service. Read [the architecture and threat model](docs/ARCHITECTURE.md) and [frontend integration notes](docs/FRONTEND_INTEGRATION.md) before extending it.
