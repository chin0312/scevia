# Phase 3 accounting and financial imports

The initial implementation separates normalized CSV observations, identity groups, accounting effects, and derived state. Import batches retain their normalized rows and owner-visible audit references. An atomic confirmation publishes a batch to replay. Replay derives the ledger on read from one set of active batches and posts no cumulative side effects. Existing provider endpoints continue returning source observations. A portfolio with connected provider accounts reports partial accounting until those observations can be matched. No provider source identity is assumed equivalent to a CSV identity.

## HTTP workflow

All paths below are under `/v1/portfolios/{portfolioId}` and require the portfolio owner's bearer credential.

| Operation | Contract |
| --- | --- |
| POST `/imports/preview` | JSON body with a `csv` string. Returns normalized rows, row validation issues, unresolved row count and an expiring batch ID. An invalid row rejects the entire preview. |
| POST `/imports/{batchId}/confirm` | Confirms the batch. Repeating confirmation preserves the original confirmation timestamp. Use `?replaces={priorBatchId}` to atomically supersede an entire confirmed batch with a corrected complete replacement. |
| GET `/imports/{batchId}` | Returns normalized observations and batch confirmation/supersession metadata. |
| GET `/accounting?asOf={ISO timestamp}` | Returns identity groups, ledger rows, holdings, cash by account and asset, and discrepancies. The optional cutoff uses economic timestamps. The result uses currently active corrections, including for earlier cutoffs. |

Preview expires in 30 minutes. Expired previews are inaccessible and purged on the next preview for that portfolio. Request bodies are bounded to 512 KiB, with 2,000 data rows and 25 retained batches per portfolio. Raw file bytes are not stored. Import evidence is data only and the API emits JSON. A production retention/deletion policy and configurable large-import handling are future work.

## Canonical Scevia CSV

```csv
venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset
fixture,local,opening,2026-11-25T00:00:00Z,,opening_cash,,USDC,,,0,,
fixture,local,deposit,2026-11-25T01:00:00Z,,deposit,,USDC,,,1000,,
fixture,local,buy-1,2026-11-25T02:00:00Z,,buy,yes,USDC,100,0.40,,0,
fixture,local,buy-2,2026-11-25T03:00:00Z,,buy,yes,USDC,100,0.60,,0,
fixture,local,sell-1,2026-11-25T04:00:00Z,,sell,yes,USDC,80,0.75,,0,
fixture,local,mark-1,2026-11-25T05:00:00Z,,mark,yes,USDC,,0.55,,,
```

Headers are fixed. Cash amounts and fees are unsigned inputs with direction provided by the type. Supply stable event IDs scoped to venue/account. A transaction hash alone may represent multiple fills. Use a trusted event ID where available. Without one, keep the ID blank to retain the row as unresolved. Use a sequence to resolve position-changing events at the same time. Timestamps use offsets and up to millisecond precision. Exact normalized batch content is order-independent. Identical rows with the same stable ID across batches produce one event and preserve references to all source rows. Conflicting rows with the same ID are quarantined until corrected; an import row number never identifies an economic event.

Opening cash, contributions, withdrawals, standalone fees, rewards and rebates use amount. Opening position requires instrument and quantity; amount is total basis and may be omitted. Buy and sell require instrument, quantity and unit price. A blank fee is unknown; use explicit zero for a known fee-free transaction. Fee asset defaults to the collateral asset. Settlement uses quantity and per-unit payout. Redemption uses quantity and actual cash received. Marks use instrument and price. Split and merge evidence is retained unresolved pending explicit multi-leg accounting.

Only this format is supported. Kalshi documents CSV export availability but the exact schema and version were not verified for a reliable mapping. No Polymarket export mapping was verified. See [Kalshi Trading History](https://help.kalshi.com/en/articles/13823848-trading-history).

## Calculation convention and availability

Weighted average cost gives a single reproducible basis for partial exits. Buy fees in the settlement asset enter basis. Sell fees reduce proceeds. Cross-asset fees are separate cash effects and prevent an exact single-asset P&L where conversion would be needed. Unavailable buy fees invalidate basis; unavailable sell fees invalidate realized proceeds. A full exit releases all remaining basis and a subsequent buy starts a new holding. The engine uses decimal strings, 70-digit working precision, and half-even rounding for repeating divisions. The method serves portfolio analysis rather than tax-lot reporting. Provider averages and existing frontend sample metrics require separate comparisons.

Deposits and withdrawals change net contributions. Blank opening cash leaves cash balance unknown even when cash changes are available. Settlement removes inventory, releases basis, recognizes gain/loss, and records an entitlement. A matching full redemption moves the pending entitlement to cash with no second realization. Partial/mismatched redemptions are unresolved. Asset balances are separate without implicit conversion.

A mark applies only at or after its timestamp. An imported mark is estimated and stale after 24 hours. Valuation excludes look-ahead and returns null when required marks, opening cash or relevant amounts are missing. In the fixture above at 05:00 the independently expected and tested results are basis 60, average cost 0.50, 120 shares, cash 960, market value 66, realized 20, unrealized 6 and portfolio value 1,026. A mixed portfolio reports partial results. Unknown cost, fees and unmatched observations remain visible, with known amounts explicitly scoped to posted effects.

## Handoff and review gates

Phase 2B should show imported, estimated, provider-reported and unavailable amounts distinctly. Phase 4 should consume replay results only with their coverage and discrepancy status. A normalized archive and independent replay are available now. Provider-to-CSV evidence links, reconciliation against source position/cash snapshots, general split/merge and partial redemption, and historical time series beyond single-cutoff replay still require implementation. Existing Phase 2A data-use gates remain. No live financial records were queried in this phase.

For future chain evidence, the MIT [Subgraph V2 exchange handler](https://github.com/psyberck/polymarket-subgraph-v2/blob/main/src/handlers/ExchangeMapping.ts) models decoded fill fees and cost basis with log identity. Use it as a reference for role, collateral and reorganization tests; no source code or dataset was incorporated into this implementation.
