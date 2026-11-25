# Data acquisition decision

Keep the venue-native account and market contracts for the controlled Phase 2A baseline. Evaluate Predexon first for wallet history and HyperSync or licensed Goldsky data for independent fill and fee evidence. Use permitted venue reads for recent holdings and market rules. An official API alone cannot establish actual historical fees or canonical identity for every fill.

| Candidate | Evidence and fit | Cost and unresolved questions |
| --- | --- | --- |
| [Predexon](https://docs.predexon.com/llms.txt) | Wallet positions include historical positions. Wallet P&L exposes realized time series, unrealized values and fee totals, with documented rolling-window limitations. Per-market performance is paid. Trade history exposes fee data and wallet filtering on maker attribution. The catalog covers Polymarket and Kalshi and includes market activity and price endpoints. Compare coverage, event IDs, split/merge/redemption behavior, and accounting against chain evidence before relying on reported P&L. | [Pricing](https://predexon.com/pricing) documents a key, 1 request/sec, 1,000 premium requests/month and unmetered historical trades on Free. Dev is $49/month. Per-market performance requires Dev or Pro. Exact positions/P&L entitlement, retention, and rights need confirmation. |
| [Goldsky](https://goldsky.com/blog/prebuilt-crypto-datasets-analytics) and [CryptoHouse](https://crypto.clickhouse.com/) | Goldsky documents order_filled, orders_matched, user_balances and user_positions for Turbo. Goldsky also documents Polymarket Feeds. CryptoHouse is a separate free SQL service. The presence and completeness of these four tables in the free catalog were not confirmed. | Confirm coverage of both exchange generations, tx hash and log index, fee and asset semantics, freshness and export terms on the exact service. No feed or pipeline was provisioned. |
| [Predictefy](https://docs.predictefy.com/) | Unified Polymarket, Kalshi and Predict.fun market reads are promising for a later catalog comparison. Its [account guide](https://docs.predictefy.com/guides/accounts/) distinguishes wallet reads from workflows that require venue ownership authentication. Verify per-venue fills, balances, identity and fee semantics before treating the normalized contract as equivalent across venues. | Free advertises 25,000 credits/month. Credits are weighted by endpoint, so 25,000 credits cannot be budgeted as 25,000 requests. An account-level workload quote remains unverified. |
| [Envio HyperSync](https://docs.envio.dev/docs/HyperSync/overview) | Targeted Polygon contract/topic and block queries can retrieve event identities and raw fee evidence without a whole-chain indexer. Decode versioned exchange and collateral contracts, account for reorgs, and distinguish maker/taker and fee/refund records before publishing totals. | [Tokens and limits](https://docs.envio.dev/docs/HyperSync/api-tokens.md) documents one personal free token and weighted rate budgets shared across chains. Measure the cost of bounded scans before sizing a production plan. |

At one premium read per wallet per day, 10 wallets would use roughly 300 premium calls/month, 50 would use 1,500, and 100 would use 3,000, before pagination or retries. Predexon's published quota could accommodate the first case if the endpoint is eligible. A second premium endpoint doubles those estimates. Historical reads can still exhaust practical throughput under the 1 request/sec limit. Cache public search independently of private wallet sync and size the production plan after permission, endpoint weights, and pagination are measured.

## Reference implementations and proof of concept

- [Polymarket Subgraph V2](https://github.com/psyberck/polymarket-subgraph-v2) is MIT licensed. Its schema and handler tree separate Exchange, Conditional Tokens, collateral, transfers and auto-redemption, a useful starting point for testing version-aware reconstruction. Accounting and rollback behavior have not been independently validated.
- [poly_data](https://github.com/warproxxx/poly_data) is GPL-3.0. Evaluate as a standalone historical data reference and review license obligations before incorporating code. [PMXT](https://github.com/pmxt-dev/pmxt) is MIT with an explicit unified schema and schema drift tests. Its archive is a market-data reference and requires a separate dataset-rights review.
- On 2026-11-25 the public, unauthenticated HyperSync Polygon height endpoint returned height 97,929,799. This exercised a documented metadata endpoint without transmitting a wallet address. Contract logs, fee amounts, historical ranges and wallet capabilities remain unverified. No populated wallet or contract-event data was requested.

## Provenance, authority and permissions

One venue account should hold the portfolio association. Each supplemental observation must retain acquisition source, endpoint, source version, record identity and observed time. For chain observations retain chain ID, contract, transaction hash, log index, block hash and finality. Use observed time for freshness and source event time for economic ordering. Cross-source observations are candidates for reconciliation against one economic event. Store third-party P&L as an external observation until its fee, cost basis and coverage assumptions are checked. Phase 3 owns conflicts, correction replay, fee attribution, collateral transfers, settlement and redemption accounting, and CSV overlap.

The [Polymarket Terms of Use](https://polymarket.com/tos) remain a dependency for live validation. Obtain confirmation of applicable rights for capture, commercial analytics, derived results, caching, retention and display separately from software licenses and pricing. No intermediary was verified to confer those rights. A wallet-filtered hosted query reveals the selected wallet to the service even if it carries no Scevia user ID. Confirm query logging and retention, use server-side credentials, and avoid forwarding any unnecessary account identifiers. The next evidence milestone is an authorized wallet sample plus a bounded comparison of source fill IDs, decoded fees and portfolio readback.

## Acquisition decision for the restricted baseline

Use deterministic fixtures for Phase 2B until permitted data is available. Use venue OPEN observations for current holdings and Gamma/CLOB for market discovery and reference marks only after the intended use is confirmed. Start Phase 3 with user-provided imports and explicitly unresolved evidence. Evaluate bounded Polygon receipt/log retrieval as the strongest candidate for fill identity and fee verification. Identify logs by chain, transaction and log index and retain block hash and contract version for reorg handling. Determine actual fees with the version-specific ABI and fee/refund semantics. Treat deposits, withdrawals, splits, merges and redemptions as source evidence until matched to the appropriate account and collateral ledger.

### Predexon contract check and reproduction

The [historical trades schema](https://docs.predexon.com/api-reference/trading/trades) documents token and condition IDs, raw and normalized shares, price, maker and taker addresses, transaction hash, order hash, fee_usd and exchange versions 1–3. The wallet filter matches maker attribution. A transaction can include several fills and an order can be filled in parts. The reviewed schema has no documented per-fill ID or log index. It therefore does not establish unique economic events or complete wallet coverage on its own. The documented fee field defaults to zero, so compare it against actual fee logs before treating zero as verified. Blockchain-oriented fields do not independently establish completeness or the origin of every field.

Trade history is documented as unmetered, with a page size up to 500 and an API key. [Wallet positions](https://docs.predexon.com/api-reference/wallet/positions) uses up to 200 rows per page and [wallet P&L](https://docs.predexon.com/api-reference/wallet/pnl) reports rolling-window caveats. Verify free entitlement for both; per-market wallet performance is documented as Dev/Pro only. No authorized test key or approved wallet sample was supplied for this evaluation. After the maintainer confirms rights and wallet-query retention, run a bounded test with server-side credentials:

```sh
curl --fail-with-body -G 'https://api.predexon.com/v2/polymarket/trades' \
  -H "x-api-key: $PREDEXON_API_KEY" \
  --data-urlencode "wallet=$AUTHORIZED_WALLET" \
  --data-urlencode "start_time=$START_UNIX" --data-urlencode "end_time=$END_UNIX" \
  --data-urlencode 'limit=20'
```

Repeat the same bounded range and compare transaction/order groups and raw financial fields with approved Polygon receipts, including a multi-fill transaction. Check both role directions, exact fee units, missing versus zero fees, pagination and matching to known instrument IDs. For HyperSync, obtain a token and approval for the intended log use, query one approved block range and the documented exchange contracts, and compare chain, transaction, log index, contract, block hash and decoded fee fields against the receipts. Goldsky order_filled is another candidate for this exact comparison after dataset entitlement and rights are confirmed. The earlier public height response was connectivity evidence only. No new live financial proof of concept was possible with the available access.

### Code reviewed

The MIT [Subgraph V2 exchange handler](https://github.com/psyberck/polymarket-subgraph-v2/blob/main/src/handlers/ExchangeMapping.ts) uses block number plus log index for its indexed row and records decoded fee data before updating position cost basis. Scevia should retain transaction and block hashes as well and test its own version, rollback and role semantics. The MIT [Prediction Market Analysis decoder](https://github.com/Jon-Becker/prediction-market-analysis/blob/main/src/indexers/polymarket/blockchain.py) preserves transaction hash, log index and raw fee. Its ABI is a reference for the contract it decodes, and must be checked against each target deployment. No dataset rights or complete historical coverage were verified for reuse.

### Illustrative monthly request budget

Assume one wallet per user, an initial 10 trade pages and 5 activity pages, and eight on-demand refreshes per wallet per month. Each refresh uses one current position page, one incremental trade page and one activity page. Assume two bounded fee-evidence lookups per wallet in the first month and a 20% retry margin. Public lookup traffic is shared across users. Budget 120 searches, 30 link resolutions, 60 reference-price bundles and 30 history requests per month after cache hits. This is a request estimate. Envio weights depend on the query, and search enrichment can fan out into multiple provider calls.

| Wallets | Initial history plus incremental trade/activity with retries | Current pages with retries | Fee lookups with retries | Public requests with retries |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 38 | 10 | 3 | 288 |
| 10 | 372 | 96 | 24 | 288 |
| 50 | 1,860 | 480 | 120 | 288 |
| 100 | 3,720 | 960 | 240 | 288 |

If current pages are one premium request each and all relevant history qualifies as unmetered, that workload fits the published 1,000 premium quota at all four sizes, narrowly at 100 wallets. An additional premium call per refresh moves 100 wallets over the quota. At 1 request/sec the 100-wallet initial history alone takes at least 30 minutes with the retry allowance. Spread backfills out and keep holdings refresh on demand. If higher throughput or paid entitlements are required, the advertised Predexon Dev price starts at $49/month. Hosted data rights, Envio query costs and the cost of higher-cardinality histories still require measurement.

### Capability assignments

All live assignments below are conditional on permission and an approved test sample. Fixture coverage verifies Scevia's contracts. The reviewed upstream documentation and code do not establish populated live behavior. Apply the same wallet privacy and cost assumptions above to each account lookup.

| Capability | Preferred evidence | Alternative and acceptance check |
| --- | --- | --- |
| Current holdings | Venue OPEN observations with source-specific freshness | Compare Predexon positions against the same wallet and time window. Treat both as observations until completeness and authority are established. |
| Historical closures | Venue CLOSED evidence | Compare Predexon historical positions; only a current-state observation can substantiate the current balance. |
| Trades | Bounded independent contract evidence for canonical fills; venue and Predexon for source history | User CSV is a separate source. Match venue and instrument identity, roles, quantities and fees before combining sources. |
| Economic identity | Versioned Polygon logs with chain, transaction and log index | Licensed Goldsky event rows or approved receipt retrieval. Order hash and transaction hash alone leave multiplicity unresolved. |
| Historical execution fees | Decoded version-specific fee and refund evidence | Predexon fee_usd is a comparison value until units, role, missing values and fee corrections reconcile. |
| Cash and collateral balances | Approved chain balance evidence for explicit collateral contracts | Licensed Goldsky balance data where the asset, account and as-of block can be verified. No lifetime cash ledger follows from a balance alone. |
| Deposits and withdrawals | Venue observations plus versioned collateral transfer and bridge evidence | User CSV for declared cash movements. Classify contribution, withdrawal or internal transfer only after reconciliation. |
| Splits and merges | Conditional Tokens and collateral adapter events | Venue or licensed historical activity helps locate candidates. Verify legs and collateral and avoid classifying these as trades. |
| Redemptions and settlements | Resolution payouts plus decoded redemption receipts | Venue redemption activity and approved user CSV are supplemental. Reconcile payouts and redeemed quantities as separate facts. |
| External P&L benchmark | Predexon wallet P&L, if coverage and entitlements are confirmed | Compare against Scevia's future reproducible reconciliation by role, accounting period, fees and cost basis. |
| Market metadata and rules | Venue market and event metadata | Managed catalogs can help discover IDs. Resolve versioned instrument mappings and conflicts against venue rules. |
| Public search and link resolution | Gamma search and explicit supported venue URL resolution | A managed catalog is a fallback only if it preserves venue-native IDs and link semantics. Share cache across authorized requests. |
| Market fee schedules | Venue market-specific schedule | Allow user assumptions for simulation. Keep actual historical fees and rebate eligibility separate. |
| Reference and historical prices | CLOB midpoint and venue price history | Managed candles are fallback observations with their own timestamps and aggregation. Midpoints are references and carry no execution guarantee. |
