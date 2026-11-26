# Phase 6 Kalshi integration

## Authorization and connection state

The standard server leaves public and private Kalshi access disabled by default. Explicitly authorized loopback development can enable public catalog reads independently. Account ingestion also needs separate authorization for the public metadata it uses. The server binds one signing key to a registered portfolio, its configured development owner, the provider account UUID, the API environment and the primary prediction account. The public transport never sends signing headers. Demo catalog and scenario identities carry a `demo:` prefix so matching production tickers remain distinct. Run each environment in a separate development workspace when reviewing populated data.

The server uses the existing sync route. It has no credential upload, order, key creation, or production onboarding route. A local owner-only PEM file supplies an Ed25519 or RSA key. Before sending private reads, the client matches exactly one key record and verifies its read-only scopes and supported binding. A successful check is cached for at most 30 seconds for the same signing material. Replacement and upstream 401/403 invalidate the cached decision. Missing or excessive scopes and unsupported bindings fail closed. [Key listing](https://docs.kalshi.com/api-reference/api-keys/get-api-keys)

The published Trade API describes resource-bound OAuth scopes for MCP on supported portfolio endpoints. That does not establish generic onboarding, archive access, or Scevia retention rights. Confirm partner eligibility, permitted endpoints and retention with Kalshi before choosing an external onboarding design. [Kalshi OpenAPI](https://docs.kalshi.com/openapi.yaml)

Kalshi documents Ed25519 and RSA-PSS SHA-256. Both sign the millisecond timestamp, GET and exact API path without its query. The client accepts an injected signer, restricts reads to named endpoints on fixed demo and production Trade API hosts, rejects redirects and does not log authentication material. The key listing contract returns scopes, so the client can verify that exactly one entry identifies the signing key, that broad read is present and that no unknown or write permission is granted. The balance-only child scope is insufficient for the account pipeline. Successful GET requests alone establish no permission boundary. [API keys](https://docs.kalshi.com/getting_started/api_keys) · [Key listing OpenAPI](https://docs.kalshi.com/api-reference/api-keys/get-api-keys) · [Environments](https://docs.kalshi.com/getting_started/api_environments)

Section 3 of the published agreement limits API use and restricts data collection, storage and sharing. Scevia needs written authorization for its intended account and public-market data use before enabling live calls. That permission must cover purposes, retention, sharing, deletion and environment. Scope inspection and documented public endpoints do not establish those rights. This work uses synthetic fixtures only. [Kalshi Developer Agreement](https://kalshi-public-docs.s3.amazonaws.com/Kalshi-Developer-Agreement.pdf)

## Supported acquisition

- The supported account scope is the primary predictions account and exchange index 0. Live rows must supply the supported exchange index. An explicit non-primary subaccount is ineligible. Current positions are retrieved with unsettled status and a single snapshot timestamp. Signed net quantities map to the selected YES or NO instrument with an absolute quantity. An eligible provider remaining-cost observation excludes fees and is independent of reconstructed basis. Live inventory is incremental and partial, including after an empty traversal. The synthetic complete-snapshot fixture can establish absence under its own contract. Provider positions remain separate from ledger positions.
- An initial live fill pass traverses bounded current and archive cursors, keeping the same native fill ID across the transition. The sync window and cursor are durable. Following a traversed pass, a one-hour overlap permits recent refresh when the window remains entirely on the live side of the independently reported fill cutoff. Otherwise both tiers are queried again. Settled-position observation still reads live and archive separately because its cutoff describes a buffered event handoff. Older corrections and authoritative continuity require independent evidence. Overlap coalesces through ingestion, while completed requests do not prove continuous account history. Matched fills use decimal contracts, side-specific dollar prices and actual reported fees. A directional bit without sufficient evidence to distinguish a buy from a sale remains unresolved for Phase 3. Orders are outside ingestion. [Fills OpenAPI](https://docs.kalshi.com/api-reference/portfolio/get-fills) · [Historical partitions](https://docs.kalshi.com/getting_started/historical_data)
- Available cash is read as fixed-point dollars, with a safe integer-cent fallback. Snapshot coverage belongs to the scoped account and does not imply an opening cash declaration. Settlements are retained as unresolved evidence because the provider response does not establish economic allocation or complete historical settlement history. Settled positions traverse their own live and archive cursors and appear as observational facts without updating current positions or posting to the ledger. Deposits, withdrawals and credits are retained as source observations. Applied rows require account and ledger reconciliation. Pending, failed and returned observations do not post cash. Inter-account transfers are outside ingestion. [Positions](https://docs.kalshi.com/api-reference/portfolio/get-positions) · [Balance](https://docs.kalshi.com/api-reference/portfolio/get-balance) · [Settlements](https://docs.kalshi.com/api-reference/portfolio/get-settlements)
- The transport classifies rate limits and server errors for the ingestion layer's bounded retry policy. Kalshi publishes separate read budgets and balance limits. [Rate limits](https://docs.kalshi.com/getting_started/rate_limits)

## CSV and catalog contracts

Kalshi offers activity CSVs by category and separate yearly realized P&L CSVs. The public instructions establish their availability, but not stable column schemas. In `POST /v1/portfolios/{id}/imports/preview` supply `kalshiMapping` with `format: kalshi_activity`, a local account label, activity category, explicit dollars or cents, and exact header names. Fills require ID, timezone-bearing timestamp, ticker, YES/NO side, buy/sell action, quantity and price. Cash activity requires ID, timestamp and positive amount. Fees are optional on fills. This is an explicit mapping, and it rejects unsupported categories rather than treating an order export or P&L summary as an activity ledger. Use existing account association and source linking for a connected account. Native tickers map to canonical instruments only on an exact venue/ticker/outcome association. Confirmation, replacement and reconciliation reuse Phase 3. [Trading history exports](https://help.kalshi.com/en/articles/13823848-trading-history)

The authorization-gated catalog endpoints are `GET /v1/market-catalog/kalshi` and `POST /v1/market-catalog/kalshi/resolve`. Lookup accepts a `marketTicker`; listing can use an `eventTicker` and independent cursor. Supported links use Kalshi HTTPS and the explicit `/markets/{ticker}` or `/events/{ticker}` form. The service resolves validated IDs via the Trade API and never fetches pasted URLs. Outcomes are explicit selections. Scenario inputs use `assetIdType: kalshi_outcome` and an ID such as `KX-EXAMPLE:no`. Quotes are retrieval-time last trades, with a labeled complementary NO quote. No schedule is manufactured for hypothetical fees.

For active supported USD $1 binary contracts, a positive-size uncrossed two-sided book can supply a midpoint. The mark uses Scevia retrieval time with source quote fields preserved. NO uses the binary complement. This indicative mark is neither an executable quote nor a last-trade timestamp. It is available to ledger and scenario valuation when the rest of the relevant financial evidence is eligible. The provider-observed view can still value supported observed rows independently. A balance snapshot does not establish opening cash or historical completeness. [Market quote fields](https://docs.kalshi.com/api-reference/market/get-market) · [Position cost fields](https://docs.kalshi.com/api-reference/portfolio/get-positions)

## Authorized local setup and verification

Obtain written approval for the intended environment, account, public catalog, and retention. Use a disposable local database, a dedicated read-only key issued for the approved account and the local principal owning the intended portfolio. Use separate keys and databases for demo and production. Keep the PEM outside the repository. A new key ID requires restarting the server after verifying that it belongs to the same approved account.

```sh
cd backend
npm ci
npm run db:migrate
export KALSHI_ENVIRONMENT=demo
export KALSHI_PUBLIC_DATA_AUTHORIZED=YES
export KALSHI_ACCOUNT_DATA_AUTHORIZED=YES
export KALSHI_PRIVATE_KEY_FILE=/absolute/path/to/kalshi-read.pem
chmod 600 "$KALSHI_PRIVATE_KEY_FILE"
# Supply existing local owner, portfolio, and approved key IDs.
export KALSHI_KEY_ID='<approved read-only key ID>'
export KALSHI_PORTFOLIO_ID='<existing owned portfolio UUID>'
export KALSHI_PROVIDER_ACCOUNT_ID="$(psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 \
  -v portfolio="$KALSHI_PORTFOLIO_ID" -v owner="$DEV_PRINCIPAL_ID" -v venue_env="$KALSHI_ENVIRONMENT" <<'SQL'
INSERT INTO scevia.provider_accounts (portfolio_id, provider_code, external_account_id, label, kind)
SELECT id, 'kalshi', 'kalshi:' || :'venue_env' || ':primary:0', 'Approved Kalshi account', 'authenticated_account'
FROM scevia.portfolios WHERE id = :'portfolio'::uuid AND owner_id = :'owner'::uuid
RETURNING id;
SQL
)"
test -n "$KALSHI_PROVIDER_ACCOUNT_ID"
npm run dev
```

Source registration is once per portfolio and environment. For an existing authorized source, look up and reuse its UUID. Account sync uses the same environment and owner as registration. Keep development credentials out of client-side code, shell tracing and shared output.

In a second local terminal with the same account, portfolio and development-token environment, run the following after authorization. Retain evidence only as permitted.

```sh
api=http://127.0.0.1:3001/v1
portfolio="$api/portfolios/$KALSHI_PORTFOLIO_ID"
sync="$api/provider-accounts/$KALSHI_PROVIDER_ACCOUNT_ID/sync"
auth="Authorization: Bearer $DEV_AUTH_TOKEN"
curl -fsS "$api/providers"
curl -fsS -H "$auth" -X POST "$sync?scope=current"
curl -fsS -H "$auth" -X POST "$sync?scope=history"
curl -fsS -H "$auth" -X POST "$sync?scope=history"
curl -fsS -H "$auth" "$portfolio/coverage?providerAccountId=$KALSHI_PROVIDER_ACCOUNT_ID"
curl -fsS -H "$auth" "$portfolio/sync-runs"
curl -fsS -H "$auth" "$portfolio/positions?providerAccountId=$KALSHI_PROVIDER_ACCOUNT_ID"
curl -fsS -H "$auth" "$portfolio/cash-balances"
curl -fsS -H "$auth" "$portfolio/accounting?view=detail"
as_of="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl -fsS -G -H "$auth" "$portfolio/analytics/exposure" --data-urlencode "asOf=$as_of" -d asset=USD -d venue=kalshi
```

Reconcile an approved populated statement against account cash, exact decimal quantities, fills, fees and at least one partial sale and settlement. Review unapplied cash and settlement facts via `/activity-facts`. Compare the opening state, reconstructed ledger and reported observations independently. Confirm replay, performance, allocation and risk under the same cutoff. Then evaluate, save and compare a scratch and actual-baseline scenario using the [scenario API](SCENARIOS.md). An empty source, successful sync attempt, synthetic result or supported-subset calculation cannot satisfy populated financial acceptance. Conditional fees, statement-grade settlements, full native link discovery and multi-denomination scenarios remain open implementation work.

## Cross-platform financial scope

Source ownership, coverage and funding remain per account. USD and USDC use separate native ledger and scenario valuations. The denominations route exposes native bucket totals and can return an indicative USD display total using an explicit positive `assumedUsdPerUsdc`. The conversion is unavailable with incomplete or unsupported evidence. This assumption never changes native accounting, scenario funding, or settlement. Scenario evaluation still uses one denomination.

Native event IDs remain separate, and a title match does not create a payout relationship. Existing reviewed rule and constraint authorities continue to govern actual exposure. Scenario-only declarations can qualify unsupported instruments. A cross-denomination hedge does not produce combined contractual extrema without compatible verified payout inputs.

The authorization-gated `GET /v1/market-catalog/kalshi/history` endpoint accepts a native market ticker, outcome, Unix seconds and a 1, 60 or 1440 minute interval. It caps the archival window at 500 periods. Observations use archived YES closes or their explicitly labeled NO complements. Empty candles preserve nulls and no continuous chart coverage is claimed. Recent candle stitching is deferred. [Historical candlesticks](https://docs.kalshi.com/api-reference/historical/get-historical-market-candlesticks)
