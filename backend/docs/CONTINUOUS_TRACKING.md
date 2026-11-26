# Phase 7 continuous tracking

The first tracking slice adds a PostgreSQL-backed worker to the loopback development server. The owner watches up to 20 native catalog markets per workspace. A public market has one schedule across all interested workspaces. A second loop syncs explicitly approved account IDs through the existing ingestion leases, checkpoints, bounded page limits and overlapping windows. It schedules current snapshots and historical streams independently. A quote change does not call account endpoints.

## Operations and API

Before enabling, record the provider permissions for collection, frequency, retention and display. The documented endpoints and rate limits are technical capabilities. The terms and any additional approval govern use. See [Polymarket terms](https://polymarket.com/tos), [Polymarket rate limits](https://docs.polymarket.com/api-reference/rate-limits), [Kalshi developer agreement](https://kalshi-public-docs.s3.amazonaws.com/Kalshi-Developer-Agreement.pdf), [Kalshi data terms](https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf), and [Kalshi rate limits](https://docs.kalshi.com/getting_started/rate_limits).

Run `npm run db:migrate` locally. Set the existing provider-specific gates and then set:

- `CONTINUOUS_TRACKING_ENABLED=YES` on the loopback development server.
- `MARKET_TRACKING_RETENTION_DAYS` to the approved integer duration from 1 through 90. The bounded cleanup deletes expired shared references only. Saved scenario inputs are frozen. Historical requests can lose coverage once an eligible observation expires.
- `MARKET_TRACKING_INTERVAL_MS` and `ACCOUNT_TRACKING_INTERVAL_MS` for approved cadence. Defaults are five and fifteen minutes respectively. History jobs use four times the account interval before retry backoff.
- `TRACKED_PROVIDER_ACCOUNT_IDS` to an optional comma-delimited list of approved, owned source UUIDs. Kalshi additionally requires the established account and credential binding. A CSV bucket has no account poll.

Authenticated `PUT /v1/portfolios/:portfolioId/tracking/markets` replaces the watchlist using `{"markets":["<catalog market UUID>"]}`. Use an empty list to remove all watches. Watches use existing provider-native catalog records and verified settlement denominations. `GET /v1/portfolios/:portfolioId/tracking` returns market and account attempts, latest successful checks, failures, upcoming attempts and latest shared observation provenance. Use the quote clock for market references and the accounting response for valuation availability. A successful metadata refresh alone says nothing about quote freshness or cash. The existing per-account sync endpoint remains the manual path. Remove a local account ID from the allowlist and restart to unschedule it, or disable its source.

Jobs claim due rows transactionally. An expired claim can be recovered after restart. Failed polls back off with jitter. Market jobs time out at 15 seconds. Shutdown aborts market requests and waits for an in-progress bounded account sync. Closed, resolved and unknown markets move to hourly monitoring. No settlement follows solely from a status or expected date.

## Prices and financial state

The worker reads standard Kalshi book midpoints and Polymarket CLOB midpoints when Gamma identifies the exact condition and maps distinct native outcomes to CLOB tokens. The catalog must agree on denomination. Unestablished identities and absent prices produce no mark. Midpoints use the retrieval clock and leave the source observation clock null. Kalshi last trade fallbacks are excluded. Shared evidence is isolated from private financial records. Records deduplicate by instrument, asset, source and retrieval time, and an inconsistent price for that identity causes a retry. Late observations are retained without replacing newer reference timestamps.

Accounting, risk and new scenario previews can consume the projected mark using existing canonical, denomination-matched financial evidence. Explicitly mapped CSV portfolios can benefit from shared market updates. Demo holdings with exact native catalog matches can consume the same observation while maintaining simulated IDs and financial ownership. Eligible demo lifecycle evidence also flows through the shared worker and existing derived settlement path. Saved scenarios do not rebase on market changes. Historical routes use a prior eligible observation and bounded in-range observations, with the original timestamps. Cash, quantities, basis, source evidence and settlement authority remain with the canonical ledger.

This slice revalues on read using the latest eligible marks in a coherent database snapshot. It does not publish a materialized valuation or recompute on every poll. The current valuation endpoint can reuse the prepared financial state across quote revisions. Historical analytics still use canonical replay, and large scopes can reach the existing replay limits. Durable valuation materialization and live streaming remain future work.

## Provider and cost decisions

Start with bounded polling over the existing PostgreSQL deployment. The [Polymarket market channel](https://docs.polymarket.com/market-data/realtime-data) is a candidate for higher-frequency shared delivery. [Kalshi WebSockets](https://docs.kalshi.com/websockets/websocket-connection) require an authenticated handshake. Defer streams until authorized workloads justify them and recovery semantics are tested. Neither stream is enabled here.

A five-minute cadence targets up to 288 market jobs per tracked active market per day before global scheduling, jitter and backoff. A successful open Polymarket poll uses a condition lookup and midpoint call. The scheduled Kalshi lookup skips fee metadata. At most three market jobs are picked each five-second loop per process. Ten consistently open markets sharing a five-minute cadence imply roughly 2,880 jobs per day across all their portfolios, rather than 2,880 per portfolio. Account requests depend on provider streams and pages, and initial catch-up is more expensive than overlapped runs. A single PostgreSQL deployment suffices for this fixture-backed implementation. No paid provider, second datastore or incremental infrastructure charge has been verified. Measure provider units, database bytes and operational cost before selecting a Beta cadence or paid service.

## Authorized acceptance

1. Confirm written permission for the intended data uses, locality, retention, provider endpoints or exports, and approved Polygon RPC. Choose one approved populated Polymarket wallet with a bounded date range and representative transaction hashes. Supply scoped Kalshi primary-account credentials through the existing restricted file mechanism, or use a permitted CSV export.
2. Follow the [Polymarket verification](POLYMARKET.md) and [Kalshi verification](KALSHI.md) workflows. Use the approved receipt reader for exact chain, contract and log evidence. Compare fills, charged fees, rebates, cash, collateral, positions, settlements, redemptions and P&L with independent statements. Repeat incremental sync and validate late events and deduplication. Keep attribution and unsupported exchange generations unresolved where evidence is insufficient.
3. Follow the [demo capture workflow](DEMO.md) with real active and resolved markets, timestamped prices, approved collateral and resolution evidence, and explicitly hypothetical trades and capital. Compare separate cash and exposure states, historical returns, correction-aware settlement, and saved scenarios with independently computed results.
4. Enable the approved tracking cadence, compare the separate clocks and affected portfolio values across one market update and one financial update, interrupt and restart the worker, and record request count and database growth. Capture evidence in an approved private location. Keep account identifiers and provider credentials out of PRs and CI.

The above authorization and evidence have not been supplied. Historical transaction discovery, chain linkage and execution-fee attribution, general collateral classification and settlement/redemption reconciliation, broader Kalshi financial coverage and account scale validation remain open. See the [handoff](PHASE7_HANDOFF.md) for the next phase boundaries.

## Holdings, current valuation, and historical references

The enabled worker reconciles demand for the local owner's portfolios in pages of ten every 30 seconds. A pass considers open canonical positions, pending simulated entitlements, and recent provider snapshots that identify an instrument and asset. Disabled private sources are omitted. Automatic demand is separate from the optional 20-market watchlist. Owner-scoped `POST /v1/portfolios/:portfolioId/tracking/reconcile` runs the same reconciliation without calling providers. Workspace deletion removes its demand by foreign key. Position and source updates converge on the next pass. Select catalog markets through the manual watchlist for explicit scenario interest, including when there is no actual funded account.

The worker claims up to three market jobs per five-second loop. Standard Kalshi polling skips fee schedule lookup. The tracking response distinguishes request success, metadata time, latest eligible quote time, missing or partial outcome quotes, and verified resolution. Verified terminal evidence stops open-market marks from carrying into observed exposure. It does not post actual receipts. Persisted account rows report active scheduling separately from historical job status. Source activity is rechecked during ingestion pagination and before saving a fetched page.

For an approved captured demo, initialization registers compatible exact native catalog identities. The tracker observes closed and resolved states without growing the initialization manifest. The accounting view combines shared lifecycle evidence with the owned initialization and derives simulated effects through the canonical ledger. Verified standard Kalshi payout can advance simulated settlement, while missing payout keeps financial results unavailable. Polymarket confirmation still requires independently reviewed payout evidence through the capture workflow. The underlying hypothetical records and previously frozen scenarios remain isolated.

`GET /v1/portfolios/:portfolioId/tracking/valuation` returns current cash and holdings with financial revision, market revision, an explicit valuation time and a private ETag. Conditional requests can receive 304. The process-local bounded cache reuses the canonical ledger's prepared financial state while applying changed market references with the same valuation routines. Corrections invalidate the prepared state and ambiguous equal-time marks fall back to canonical replay. Restart reconstructs the cache from confirmed database evidence. The endpoint reads one repeatable-read evidence snapshot. It does not materialize or push portfolio updates in the background. Exposure and allocation remain available through their existing separately scoped endpoints.

Historical queries select the last original observation for each instrument, asset and UTC day, plus exact opening, closing and bounded cash-flow anchors. The chosen rows retain original timestamps and source provenance. Retention still bounds available history and can remove the only eligible opening mark when required. The API then exposes unavailable coverage or valuation rather than constructing a replacement price. A 180-day request backed by only 90 days of marks can still contain an initial gap.

## Bounded receipt review

After approved account acquisition, set `POLYMARKET_RECEIPT_DISCOVERY_AUTHORIZED=YES` in addition to the existing provider and Polygon RPC configuration. Run:

```sh
npm run verify:polymarket-account-receipts -- <owned-source-uuid> <from-ISO> <through-ISO>
```

Select an approved window of at most seven days. The script discovers up to twelve distinct candidate hashes from the owned source's persisted trades and activities. Output includes the candidate source IDs, finalized execution and fee evidence and an explicit review status. Compare exact chain, exchange, instrument, transaction and log identities against independent references. Transaction association alone does not establish one-to-one linkage or financial classification. The script does not write ledger effects. Keep the output private. Shorten the window when the result is truncated.
