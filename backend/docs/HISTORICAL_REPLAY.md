# Historical Replay

Historical Replay is the historical mode of Scenario Lab. A Scevia owner can build, analyze and compare hypothetical prediction-market portfolios with virtual money. Provider connections, actual financial records and Demo initialization are independent of Replay. Every ledger effect from Replay is hypothetical. The authoritative engine uses the canonical weighted-average ledger, historical valuation, cash-flow-boundary returns, drawdown and shared FX reporting.

## Build and prepare evidence

1. Create or resume an independent collection with authenticated `POST /v1/simulations`.
2. Use the existing Polymarket discovery and supported market URL resolution, Kalshi catalog search and exact native lookup. Discover a candidate, explicitly choose the exact event market and outcome, and submit its condition ID or ticker to `POST /v1/market-evidence`. It returns canonical outcome IDs and native denominations. Kalshi exact lookup can fall back to the historical market endpoint. Kalshi title search remains local, and wider historical keyword coverage is unverified. A discoverable title gives no assurance the market was open in the desired period.
3. Call `POST /v1/market-references/history` with the canonical outcome ID and desired UTC bounds. Reuse returned coverage and continuation until the needed evidence is available or a limit is reached. Use the returned opening reference and actual observation range. A range envelope does not imply continuous coverage. The acquisition endpoint uses only authorized native services. Replay evaluation reads the shared store and issues no provider requests. No provider or RSS feed is required for evaluation over already permitted evidence.
4. Submit the replay to the independent collection's evaluation route. A partial response identifies required evidence that is still unavailable. The UI may prepare missing history or revised assumptions and evaluate again.

## API

All paths below are under `/v1/simulations/:collectionId/replays`. They require the authenticated owner of an independent simulation collection. The server returns 404 for a foreign collection or replay. Configuration version 1 uses decimal strings and explicit ISO 8601 timestamps with offsets, normalized to UTC. Dates alone are rejected. A date-based UI should convert an analysis day to UTC start or end of day and require an explicit execution time or labelled hypothetical time convention. Opening inventory and funding occur at `from`; ordinary actions require `from < at <= through`. Future times are ineligible.

| Request | Contract |
| --- | --- |
| `POST /evaluate` | Versioned configuration. Returns normalized configuration, results, an expiring owner-bound preview token and expiry. |
| `GET /` | Saved metadata and current revisions. |
| `POST /` | `{ name, description?, previewToken }`. Freezes the reviewed evaluation. |
| `GET /:replayId` | Saved configuration, result, evidence revisions and metadata. No acquisition or recalculation. |
| `PATCH /:replayId` | `{ revision, name?, description?, previewToken? }`. Rename or edit metadata, or explicitly replace results after reviewing a new evaluation. An old revision receives 409. |
| `POST /:replayId/duplicate` | `{ name, description? }`. Copies the frozen configuration and result. |
| `DELETE /:replayId?revision=N` | Revision-checked deletion. |
| `POST /compare` | `{ replayIds: [id1, id2, ...] }`. Returns compatibility dimensions and separate summaries and curves. Normalized curves are emitted only for compatible funded and sufficiently covered replays. No ranking. |

`invalid_replay_configuration` and other validation/work-limit errors return 422. Provider acquisition errors and continuation remain on the existing market-history route. A valid evaluation may be `evaluated`, `partial` or `unfunded`. The response includes funding, evidence revisions and provenance, an event schedule, native and converted performance, history, positions, allocation and discrepancies. `replay_preview_unavailable` is 409 for an expired, evicted or inaccessible preview. Re-evaluate to obtain a new token. Saving or duplicating never modifies actual portfolios.

### Example configuration

```json
{
  "version": 1,
  "from": "2025-01-01T12:00:00Z",
  "through": "2025-01-05T12:00:00Z",
  "currency": "USD",
  "buckets": [{"id": "virtual", "venue": "kalshi", "asset": "USD", "capital": "100"}],
  "positions": [{
    "id": "position-a",
    "instrumentId": "00000000-0000-4000-8000-000000004001",
    "bucket": "virtual",
    "entry": {
      "at": "2025-01-02T12:00:00Z", "execution": {"mode": "reference"},
      "size": {"mode": "quantity", "value": "50"}, "fee": {"mode": "fixed", "amount": "1"}
    },
    "exits": [{
      "at": "2025-01-04T12:00:00Z", "quantity": "50",
      "execution": {"mode": "reference"}, "fee": {"mode": "fixed", "amount": "1"}
    }]
  }]
}
```

The UUID above is illustrative. Use an outcome from market discovery. Multiple entries and opposite outcomes retain distinct operation identities. The ledger aggregates by venue, bucket, asset and instrument using weighted-average basis. `amount` sizing is pre-fee native notional. `weight` uses the initial capital of that bucket; amount-based quantities round down to 12 decimal places. Funding feasibility uses actual modeled cash and includes fees. Shortfalls are reported at each affected action without transferring money or assuming leverage. `cashFlows` permits explicit hypothetical deposits and withdrawals at exact cutoffs.

USD belongs to Kalshi buckets, and USDC/PUSD to their compatible Polymarket instruments. A `reportingBudget` documents the sum of explicit native allocations under explicitly supplied reporting-per-native rates. Allocation rates and reporting conversions are separate assumptions. Reporting defaults to the owner's selected currency at evaluation. Shared FX is selected at historical cutoffs. Optional `assumedUsdPerUnit` stablecoin overrides remain hypothetical. No parity, transfer or swap is implied. A confirmed zero does not need an FX rate. Nonzero balances with no eligible conversion remain unavailable in the consolidated result.

## Execution, settlement and performance

- An explicit price is a hypothetical assumption within the supported unit payout bounds. Reference execution requires an exact historical observation by default. A positive `maxAgeSeconds` permits a prior observation of bounded age. A later candle cannot price an earlier action. Unknown window evidence requires explicit `allowUnverifiedWindow` and qualifies the results. Explicit price assumptions cannot bypass known trading closures or contested terminal states.
- Fees support explicit zero, native fixed charges and gross-notional rates. Unknown fees and the `provider` option without admissible historical schedule evidence remain unknown. Replay does not apply today's fee schedule retroactively. Exact provider-native historical fee schedules are an outstanding evidence dependency.
- Canonical postings order settlement entitlements, hypothetical redemptions and ordinary operations deterministically at a shared timestamp. A supported payout requires exact binary identity and admissible journal evidence. With `remainder: "settle"` redemption cash is modeled at the qualified resolution evidence time. With `remainder: "hold"` an eligible resolved position can remain a pending entitlement. Unsupported or disputed payout stays unresolved. No terminal price or actual cash receipt is inferred.
- Opening, closing, daily and financial-event samples reuse canonical per-instrument historical valuation. Carry-forward never uses future observations. Marks, price clocks, stale references, cash and position values are returned separately. Drawdown is sampled. Missing required operations or fees prevent unqualified performance. A simultaneous FX-rate change can make a cash-flow boundary ineligible under the shared conservative return calculation.
- Retrospective evaluation uses independently dated archive prices with preserved acquisition clocks. Knowledge mode admits observations no earlier than acquisition when a separate publication clock is unavailable. Neither workflow removes market-selection, hindsight, execution or survivorship bias. Shortfalls and uncertain funding suppress normalized comparison.

## Validation references

These are synthetic test cases with hand-calculated results.

- USD 100, buy 50 shares at 0.40 and sell at 0.60, with USD 1 on each leg. Lowest cash is USD 79, ending cash and value are USD 108, gain is USD 8 and return is 8%. A 0.30 intervening mark gives a 6% sampled drawdown.
- An overlapping two-entry holding with a partial exit produces 60 eligible units at resolution. Forty units are redeemed and twenty remain pending. With an independent later open holding worth USD 3, the ending portfolio is USD 137.
- USD 100 and PUSD 100 independently funded at 1.25 SGD/USD and 0.80 USD/PUSD start at SGD 225. A USD 20 contribution and subsequent PUSD rate of 0.90 give SGD 262.50 ending value, SGD 12.50 gain and 5% cash-flow-adjusted return.
- Missing evidence and unknown fees suppress complete results. Saved results survive changed observations. Explicit re-evaluation and a revision-checked update freeze the new result.

## Resource and Phase 9 handoff

`HISTORICAL_REPLAY_MAX_DAYS` caps the analysis horizon at 365 days by default. Other bounds are 20 positions, 12 buckets, 8 partial exits per position, 32 virtual cash flows, 600 reference cutoffs, 6,000 selected observations, shared ledger work limits, 4 MB per preview/result, 40 saved replays per collection, 12 process-local previews for 15 minutes, and four compared replays. Archive acquisition uses its existing bounded paging and shared cache. Run synthetic calculation and serialization benchmarks with `npx tsx scripts/benchmark-replay.ts` from the backend.

Phase 9 maps PR #1's Build · Analyze · Compare UI to canonical outcome IDs and these endpoints. Convert prototype numeric inputs to decimal strings and selected dates to explicit hypothetical UTC timestamps. Rename prototype shares/amount/weight and settle/dated-exit fields to the contract above. Render backend cash, valuations, shortfalls, provenance, FX legs and compatible normalized series directly. Keep fixtures separate and use explicit save and refresh previews. Durable previews, configurable retention of frozen results, broader real market archive coverage, authenticated deployment and public usage cost remain release dependencies.

No authorized live market, FX, payout, or populated-account validation has been performed. Use the [data acquisition checklist](DATA_ACQUISITION_STRATEGY.md#live-data-acceptance-checklist), with approved active, closed and verified resolved examples and independent quote, trading-window and payout references, before claiming real-data coverage. PositionManager settlement and unsupported contracts remain unresolved. Research candidates remain optional pending suitable access, rights and validation.
