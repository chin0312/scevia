# Historical Replay

Historical Replay is the historical mode of Scenario Lab. A Scevia owner can build, analyze and compare hypothetical prediction-market portfolios with virtual money. Provider connections, actual financial records and Demo initialization are independent of Replay. Every ledger effect from Replay is hypothetical. The authoritative engine uses the canonical weighted-average ledger, historical valuation, cash-flow-boundary returns, drawdown and shared FX reporting.

## Build and prepare evidence

1. Create or resume an independent collection with authenticated `POST /v1/simulations`.
2. Use the existing Polymarket discovery and supported market URL resolution, Kalshi catalog search and exact native lookup. Discover a candidate, explicitly choose the exact event market and outcome, and submit its condition ID or ticker to `POST /v1/market-evidence`. It returns canonical outcome IDs and native denominations. Kalshi exact lookup can fall back to the historical market endpoint. Kalshi title search remains local, and wider historical keyword coverage is unverified. A discoverable title gives no assurance the market was open in the desired period.
3. Call `POST /v1/market-references/history` with the canonical outcome ID and desired UTC bounds. Reuse returned coverage and continuation until the needed evidence is available or a limit is reached. Use the returned opening reference and actual observation range. A range envelope does not imply continuous coverage. The acquisition endpoint uses only authorized native services. Replay evaluation reads the shared store and issues no provider requests. Evaluation and frozen readback use already permitted shared evidence.
4. Submit the replay to the independent collection's evaluation route. A partial response identifies required evidence that is still unavailable. The UI may prepare missing history or revised assumptions and evaluate again.

## API

All paths below are under `/v1/simulations/:collectionId/replays`. They require the authenticated owner of an independent simulation collection. The server returns 404 for a foreign collection or replay. Configuration version 1 uses decimal strings and explicit ISO 8601 timestamps with offsets for analysis bounds and cash flows. Trade `at` also accepts a UTC calendar date, normalized to 23:59:59.999 UTC with `hypothetical_utc_day_end` timing. Set a date-based analysis opening to UTC midnight to allow an entry on the first day. Exact timestamps normalize independently. Opening inventory and funding occur at `from`, and subsequent actions require `from < at <= through`. Future times are ineligible.

| Request | Contract |
| --- | --- |
| `POST /evaluate` | Versioned configuration. Returns the normalized configuration, compact result, owner-bound preview token and expiry. Add `?detail=full` for frozen-value review material. |
| `GET /` | Saved metadata and current revisions. |
| `POST /` | `{ name, description?, previewToken }`. Freezes the reviewed evaluation. |
| `GET /:replayId` | Compact configuration, result and revisions. `?at=<ISO-UTC-instant>` returns one exact saved snapshot, or 404 if that cutoff was not sampled. `?detail=full` returns the frozen schedule, market and FX evidence dictionaries and detailed history. Snapshot FX legs refer to the revisions in the evidence dictionary. Readback does not acquire or recalculate evidence. |
| `PATCH /:replayId` | `{ revision, name?, description?, previewToken? }`. Rename or edit metadata, or explicitly replace results after reviewing a new evaluation. An old revision receives 409. |
| `POST /:replayId/duplicate` | `{ name, description? }`. Copies the frozen configuration and result. |
| `DELETE /:replayId?revision=N` | Revision-checked deletion. |
| `POST /compare` | `{ replayIds: [id1, id2, ...] }`. Returns compatibility dimensions, evidence revisions, changed overlapping sources, individual value samples and a common UTC daily grid including the matched analysis boundaries. Normalized curves use the common timestamps and are withheld when materially incompatible. The API derives no interpolated prices or ranking. |

`invalid_replay_configuration` and other validation/work-limit errors return 422. Provider acquisition errors and continuation remain on the existing market-history route. An evaluation may be `evaluated`, `partial` or `unfunded`. Read `completeness` for missing operation IDs and reasons, financial and FX coverage, and individual metric availability. Other buckets may retain explicitly qualified known subtotals. Complete P&L and normalized returns are withheld when requested operations or coverage are incomplete. The compact response includes funding, native and converted performance, chart points, positions, pooled attribution, allocation and warnings. `replay_preview_unavailable` is 409 for an expired, evicted or inaccessible preview. Re-evaluate to obtain a new token. Saving or duplicating never modifies actual portfolios.

### Valuation quality and frozen evidence

Each compact chart point includes `referenceQuality` independently of its financial and FX coverage. Compare `completeValue` with `knownComponentsSubtotal` to distinguish a supported total from known components. `referenceQuality` includes market-price coverage, the oldest applicable source observation, and counts of exact-time, carried-forward, stale, missing and unknown-age references for open positions. Stale means the source observation is more than 24 hours old at that valuation. A later retrieval or simulated ledger posting does not make the underlying mark newer. Pending entitlements and cash do not require market prices.

The summary exposes ending reference quality and separate qualifications for TWR, total return and sampled drawdown. Eligible LOCF valuations remain usable with their qualifications. Older frozen records may return null for quality fields they never stored. The API does not reconstruct those fields from current data. Primary, full, exact sampled and comparison responses share the stored chart qualification. Exact sampled details resolve quotes and FX legs from the immutable evidence dictionaries. There is no such lookup for arbitrary unsampled times.

An incomplete native denomination with eligible buckets retains an explicitly known subtotal in `native[].ending.knownValue`. Its complete value and affected return remain unavailable. A bucket with a missing execution does not contribute an assumed zero or simulated cash value. Earlier established shortfalls remain visible in funding.

Comparison retains the matched UTC grid and reports material corrections to shared evidence. `evidenceQualifications` counts matched points where applied market sources or methodologies, effective FX sources, fallback or coverage differ. Different sources and different overall evidence revisions can coexist with a qualified comparison if its financial methodology and coverage are compatible. Reference-quality counters distinguish differences in the presence of carried-forward, stale or unknown-age marks at matched points. A separate counter flags points where an older saved result lacks quality data. These differences are advisory. Source counts concern overlapping subjects. They do not imply that disjoint markets used matching evidence.

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

The UUID above is illustrative. Use an outcome from market discovery. Multiple entries and opposite outcomes retain distinct operation identities. The ledger aggregates by venue, bucket, asset and instrument using weighted-average basis. `amount` sizing is pre-fee native notional. `weight` uses the initial capital of that bucket; amount-based quantities round down to 12 decimal places. Sizing returns requested notional or quantity, evaluated quantity and the rounding residual. Decimal sizing is hypothetical when provider precision is unverified. Funding feasibility uses modeled cash and includes known fees. Shortfalls are reported at each affected action without transferring money or assuming leverage. `cashFlows` permits explicit hypothetical deposits and withdrawals at exact cutoffs.

USD belongs to Kalshi buckets, and USDC/PUSD to their compatible Polymarket instruments. A `reportingBudget` documents the sum of explicit native allocations under explicitly supplied reporting-per-native rates. Allocation rates and reporting conversions are separate assumptions. Reporting defaults to the owner's selected currency at evaluation. The initial frontend choices are USD (default), EUR and GBP. Backend SGD and MYR reporting remain supported. See the [reporting contract](DATA_ACQUISITION_STRATEGY.md#reporting-contract) for the distinction from native settlement assets. Shared FX is selected at historical cutoffs. Optional `assumedUsdPerUnit` stablecoin overrides remain hypothetical. No parity, transfer or swap is implied. A confirmed zero does not need an FX rate. Nonzero balances with no eligible conversion remain unavailable in the consolidated result.

## Execution, settlement and performance

- An explicit price is a hypothetical assumption within the supported unit payout bounds. Reference execution requires an exact historical observation by default. A positive `maxAgeSeconds` permits a prior observation of bounded age. A later candle cannot price an earlier action. Polymarket uses exact-market provider-reported `acceptingOrdersTimestamp` and closed-market `closedTime` when admissible. See the [provider market contract](https://docs.polymarket.com/api-reference/markets/get-market-by-id). These timestamps are distinct from expected resolution, event-level dates and first prices. Compatible prior journal bounds survive later sparse snapshots. Conflicting bounds are surfaced and block unqualified execution. Unavailable or partially established windows require explicit `allowUnverifiedWindow` and qualify the results. Explicit price assumptions cannot bypass known trading closures or contested terminal states.
- Fees support explicit zero, native fixed charges and gross-notional rates. Unknown fees and the `provider` option without admissible historical schedule evidence remain unknown. Replay does not apply today's fee schedule retroactively. Exact provider-native historical fee schedules are an outstanding evidence dependency.
- At a shared timestamp the canonical ledger sees opening state and marks, then contributions, entitlements, redemptions, sells, withdrawals and buys. Within a category stable operation IDs break ties. Fees are applied with their trade. Cash from earlier categories is reusable at that timestamp. If an external flow coincides with a non-flow financial operation, the current TWR contract withholds the affected return rather than treating trade effects as contributions. This order is a hypothetical convention.
- A supported payout requires exact binary identity and admissible journal evidence. `redemption` modes are `{ "mode": "immediate" }`, `{ "mode": "delay", "seconds": 172800 }`, `{ "mode": "at", "at": "2025-01-06T12:00:00Z" }`, and `{ "mode": "hold" }`. It overrides the compatible legacy `remainder` setting. Settlement creates an entitlement; later redemption converts it to virtual cash. Redemptions beyond the period remain pending. The response distinguishes provider settlement time, evidence availability, entitlement and hypothetical cash timing. Retrospective evaluation withholds payouts invalidated by later relevant evidence. Knowledge mode preserves the earlier result until the dispute evidence was acquired, then qualifies affected amounts. Unknown dispute onset is never backdated.
- Opening, closing, daily and financial-event samples reuse canonical per-instrument historical valuation. Carry-forward never uses future observations. Marks, price clocks, stale references, cash and position values are returned separately. Drawdown is sampled. Missing required operations or fees prevent unqualified performance. A simultaneous FX-rate change can make a cash-flow boundary ineligible under the shared conservative return calculation.
- Retrospective evaluation uses independently dated archive prices with preserved acquisition clocks. Knowledge mode admits observations no earlier than acquisition when a separate publication clock is unavailable. Neither workflow removes market-selection, hindsight, execution or survivorship bias. Shortfalls and uncertain funding suppress normalized comparison.

## Validation references

These are synthetic test cases with hand-calculated results.

- USD 100, buy 50 shares at 0.40 and sell at 0.60, with USD 1 on each leg. Lowest cash is USD 79, ending cash and value are USD 108, gain is USD 8 and return is 8%. A 0.30 intervening mark gives a 6% sampled drawdown.
- An overlapping two-entry holding with a partial exit produces 60 eligible units at resolution. Forty units are redeemed and twenty remain pending. With an independent later open holding worth USD 3, the ending portfolio is USD 137.
- USD 100 and PUSD 100 independently funded at 1.25 SGD/USD and 0.80 USD/PUSD start at SGD 225. A USD 20 contribution and subsequent PUSD rate of 0.90 give SGD 262.50 ending value, SGD 12.50 gain and 5% cash-flow-adjusted return.
- Missing evidence and unknown fees suppress complete results. Saved results survive changed observations. Explicit re-evaluation and a revision-checked update freeze the new result.

## Resource limits and handoffs

`HISTORICAL_REPLAY_MAX_DAYS` caps the analysis horizon at 365 days by default. Other bounds are 20 positions, 12 buckets, 8 partial exits per position, 32 virtual cash flows, 600 reference cutoffs, 6,000 selected observations, shared ledger work limits, 2.5 MB per new frozen result, 24 saved replays per collection, 8 process-local previews for 15 minutes, and four compared replays. Archived evidence uses existing bounded paging and shared caching. The evaluator bounds work before valuation and shares prepared canonical projections across reporting and detailed snapshots. Relevant marks with conflicting price, ordering or economic identity use canonical evaluation so later recovery preserves the original discrepancy and provenance. It retains frozen price and FX dictionaries, and per-point detail refers to their revisions. Run `npx tsx scripts/benchmark-replay.ts` and add `--larger` for the synthetic 20-position workload.

Phase 10 maps PR #1's Build · Analyze · Compare UI to canonical outcome IDs and these endpoints. Convert prototype numeric inputs to decimal strings and selected dates to explicit hypothetical UTC timestamps. Rename prototype shares/amount/weight and settle/dated-exit fields to the contract above. Render backend cash, valuations, shortfalls, provenance, FX legs and compatible normalized series directly. Keep fixtures separate and use explicit save and refresh previews. Durable previews, configurable retention of frozen results, broader real market archive coverage, authenticated deployment and public usage cost remain release dependencies.

Phase 9 owns authorized source selection, live market and FX access, historical coverage, actual-account reconciliation, real-market Demo acceptance and measured production cost assumptions. No authorized live market, FX, payout or populated-account validation was performed in this PR. Use the [data acquisition checklist](DATA_ACQUISITION_STRATEGY.md#live-data-acceptance-checklist), with approved active, closed and verified resolved examples and independent quote, trading-window and payout references, before claiming real-data coverage. PositionManager settlement and unsupported contracts remain unresolved. Research candidates remain optional pending suitable access, rights and validation.


### Analyze examples

For first-day reference execution, set `from: "2025-01-01T00:00:00Z"` and a trade `at: "2025-01-01"`, with `execution: { "mode": "reference", "maxAgeSeconds": 43200 }` to explicitly allow a prior observation no more than 12 hours old. A hypothetical price uses `execution: { "mode": "assumed", "price": "0.42" }` and remains subject to the trading window. Confirm `timing`, `basis` and reference age in Analyze.

For a USD/USDC portfolio, use distinct Kalshi and Polymarket buckets. An exit can sell 10 units out of a 50-unit entry. If the rest settles with a two-day delay, pending entitlement and available cash are separate until the configured redemption. A missing exit reference returns a missing operation and an affected bucket limit, while other eligible buckets can retain known values. Operation-level notionals are separate from pooled weighted-average accounting attribution. Converted market and FX P&L decomposition remains unavailable, so display native attribution and aggregate reporting-currency gain separately. Compare two frozen replay IDs using their matched UTC daily grid, and surface changed shared evidence separately from each replay's full revision identity.
