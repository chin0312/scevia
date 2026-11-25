# Polymarket provider integration

This note records the provider contract used by the Phase 2 backend adapter. Provider field and pagination descriptions below come from the current official v2 OpenAPI and Polymarket API documentation. A single controlled request to the documented example account returned empty v2 envelopes; it did not validate populated records or prove database ingestion against live wallet data. Automated adapter and PostgreSQL tests use deterministic responses.

## Endpoint capability matrix

| Source | Authentication and request | Response IDs and time | Paging and current bounds | Scevia mapping and limitations |
|---|---|---|---|---|
| Data API v2 `GET /v2/positions` | No API key; `user`, `limit=100`, `status=OPEN`, `include_archived=true`, `filter_type=TOKENS`, `filter_amount=0` | `proxy_wallet`, `condition_id`, `token_id`, optional opposite token, outcome, status flags, numeric position/P&L fields; timestamps are Unix seconds where present | Envelope contains `data` and `pagination.next_cursor`; cursor is opaque and carries status/sort/direction. The source does not provide a stable point-in-time snapshot guarantee. The API's default dust threshold is 0.1 tokens; this adapter requests zero. | Provider-reported position observations, position status flags and provider P&L values. Each observation gets Scevia retrieval time because the response lacks a dependable mark-as-of timestamp. Coverage stays partial. Absence never closes a prior position. `OPEN` includes currently held positions, including some resolved and unredeemed positions. `include_archived` does not include inactive markets. The adapter does not fetch the `CLOSED` status. |
| Data API v2 `GET /v2/trades` | No API key; `user`, `limit=100`, opaque `cursor`, inclusive `start`/`end` Unix seconds, `taker_only=false` so maker rows are included | `proxy_wallet`, `transaction_hash`, `condition_id`, `token_id`, `side`, numeric `size` and `price`, Unix-second `timestamp`; no provider trade ID or log index | Cursor pagination. The documented default history floor is three years; initial Scevia request sets `start=1`. A later run overlaps the stored window by seven days. Imports resume from committed cursor/checkpoint. | Buy and sell fill facts plus wallet-scoped market/outcome references from `/v2/tokens`. Fee is unavailable; finality is unknown. A SHA-256 composite source fingerprint is used because no stable per-fill ID is returned. Indistinguishable rows within one transaction can still collide; do not treat the fingerprint as a provider guarantee. Coverage is partial. |
| Data API v2 `GET /v2/activity` | No API key; `user`, `limit=100`, cursor and timestamp window, `exclude_deposits_withdrawals=false`; tips remain excluded by provider default | Activity type, transaction hash, account wallet, market/token IDs, optional side/size and `usdc_size`, Unix-second timestamp | Cursor pagination and timestamp overlap as above. Activity kinds include trades, splits, merges, redemptions, rewards, conversions, migrations, deposits and withdrawals. | Deposits and withdrawals with a nonzero reported amount become signed cash-movement observations. Other supported rows, including redemptions, rewards, splits, merges and conversions, remain typed `unreconciled` activity facts. Non-combo trade activity is omitted here because `/trades` supplies canonical fills; combo trade facts are retained. This is not a complete ledger and is never presented as reconciled P&L. |
| Data API v2 `GET /v2/tokens` | No API key; `token_id` list, at most 50 IDs per request | Token ID, condition ID, outcome, outcome index, opposite token and market/event metadata | No account cursor; adapter batches IDs in groups of 50 | Resolves trade token IDs to provider-native market and instrument IDs. If metadata for either outcome is missing, the trade is not normalized and the stream remains partial. |
| Gamma API `GET /public-search`, then `GET /events/slug/{slug}` or `/markets/slug/{slug}` | Public, no credentials; query text or validated slug | Provider event and market IDs/slugs, titles, descriptions, outcome labels and IDs, lifecycle fields, resolution source, close date, negative-risk flag, fee metadata where supplied | Search pagination is returned by Gamma. Scevia requests at most 10 events, fetches details with concurrency 3, and returns at most 50 markets per search response. | Stateless public search and supported event/market URL resolution. Only event results are used. Market details preserve provider IDs, multi-outcome instruments, negative-risk metadata, rules/description, lifecycle, source URL and available fee metadata. No portfolio position is created. |
| CLOB `POST /midpoints` | Public, no credentials; JSON token-ID list, at most 500 tokens per request | Current midpoint values keyed by token ID; no provider observation timestamp | One bounded batch of up to 500 IDs | `clob_midpoint` is the average of best bid and ask, not the last trade or an executable quote. A valid value is stamped with Scevia `retrievedAt`; source timestamp remains null. Missing, invalid and unrequested prices remain null with explicit freshness states. |
| Data API v2 `GET /v2/prices-history` | No API key; `token_id`, supported interval, optional `bucket_seconds` and opaque cursor | Price, Unix-second observation timestamp and `resolution_seconds` | Provider cursor; response is bounded to 500 returned points per call. Source retention depends on requested interval/resolution. | Public history is served by a read-only route and is not written to a user's portfolio. Provider timestamp and bucket resolution are preserved. No price is inferred when a point is absent. |

Polymarket's trading wallet can be a proxy/smart account distinct from a signer or funder address. This adapter sends the explicitly entered account wallet as Data API `user`, lowercased for storage, and does not discover or combine signer, funder, profile, or browser-connected addresses. A public address is not proof of ownership. Users should enter the account wallet shown for their Polymarket profile.

The Data API currently labels monetary values with names such as `usdc_size` and `entry_cost_usdc`. Polymarket's current trading collateral documentation describes pUSD (wrapped USDC on Polygon); those API field names are treated as provider valuation units, not proof of the historical on-chain token contract. The adapter does not claim a cash balance. It reports fees as unavailable because trade history has no historical fee field, and it does not apply today's fee schedule to old trades.

## Numerical and operational handling

Polymarket's Data API returns many financial fields as JSON numbers. Node.js 24's JSON reviver source context preserves those numeric lexemes for known financial keys before decimal validation. That preserves the precision actually sent in the JSON response; it cannot recover rounding performed upstream. Canonical values are decimal strings and PostgreSQL `NUMERIC(38,18)`. Values beyond that storage precision are rejected rather than silently rounded.

Requests use fixed Data API, Gamma and CLOB hosts, an 8-second HTTP timeout, a 2 MB response bound, JSON-only parsing and redirect rejection. Provider 429/503 responses honor bounded `Retry-After` values within the sync budget. Numeric rate limits are not published as a stable guarantee; API terms allow limits to change. Public search/resolve/history routes have their own API rate limit.

Each sync stream commits its pagination cursor and durable checkpoint with its records. A first history import starts at second 1, uses provider cursors, and is capped by the account execution budget, page and record limits. Each stream receives a bounded share of the sync budget so a large trades backfill cannot indefinitely prevent later activity streams from advancing. Repeated sync overlaps the prior seven-day window and deduplicates through the composite source fingerprint. Cursor ordering, snapshot stability, late-arriving history and provider record identity remain provider limitations.

The positions stream is deliberately incremental rather than authoritative. The request asks for archived `OPEN` rows and a zero token threshold, but pagination can observe concurrent account changes and no snapshot version is returned. Missing records do not close holdings. Provider status, archived/redeemable/mergeable flags and provider-reported P&L remain separately exposed. Observation retrieval time is not a source mark time.

Settlements, redemptions as accounting events, collateral balances, complete cash history, rebates and fees are not advertised as reconciled capabilities. Redemption, reward, split, merge and other unsupported accounting events remain `unreconciled` facts where `/v2/activity` supplies them. Phase 3 must reconcile those facts with trades, future provider data and any permitted chain evidence before publishing realized performance.

## Local controlled live check

The following command registers the chosen public wallet under an existing development portfolio, syncs it through the running backend, and reads back the first 100 stored records for each type. It requires only the local development bearer token, not a Polymarket credential. It writes source and sync data to the selected local portfolio. It is opt-in and is not part of CI.

```bash
export POLYMARKET_WALLET_ADDRESS='0x...'
export SCEVIA_PORTFOLIO_ID='00000000-0000-4000-8000-000000000101'
export DEV_AUTH_TOKEN='your-local-development-token'
npm run verify:polymarket
```

The script only accepts the local API at `http://127.0.0.1:3001`. It reports API-returned records and coverage; it does not claim lifetime history or accounting reconciliation. Run it only after reviewing Polymarket's current terms and confirming the intended use is permitted. The current [Polymarket Terms of Use](https://polymarket.com/tos) include restrictions affecting API data use by certain capital-market clients, including financial technology companies, absent written agreement. Scevia's classification has not been determined. Written authorization/legal review is a prerequisite before public or commercial deployment.

## Official references

- [Data API v2 migration guide](https://docs.polymarket.com/migrate/data-api-v1-to-v2)
- [Data API v2 OpenAPI documentation](https://data-api.polymarket.com/v2/docs)
- [Gamma market discovery](https://docs.polymarket.com/market-data/discover-markets)
- [Market details and identifiers](https://docs.polymarket.com/market-data/market-details)
- [CLOB prices and order books](https://docs.polymarket.com/market-data/prices-order-books)
- [Wallet and proxy-account model](https://docs.polymarket.com/trading/wallets-auth)
- [Current pUSD collateral](https://docs.polymarket.com/concepts/pusd)
- [Current fee schedule](https://docs.polymarket.com/trading/fees)
- [Terms of Use](https://polymarket.com/tos)
