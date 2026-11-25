# Phase 4 analytical API and methodology

Analytics are separate read models over the effective Phase 3 evidence and weighted-average ledger. Owner authorization and existing reconciliation decisions are applied before calculation. Each response includes an as-of timestamp, selected asset and accounts, evidence digest, accounting scope and full-account coverage status. The exposure response additionally reports the reviewed settlement evidence digest. A changed digest calls for refreshed data. Analytical requests have no portfolio write effects.

## Requests

All paths require the existing owner credential and start with `/v1/portfolios/{portfolioId}`.

| Route | Parameters and outputs |
| --- | --- |
| GET `/analytics/performance` | Required `asset`, `from` and `asOf` as ISO timestamps with offsets. Optional `venue`, `accounts` as comma-separated account identifiers and `sampling=daily\|weekly\|monthly`. Returns endpoint values, cash-flow boundaries, P&L bridge, returns, history, attribution and trading activity. |
| GET `/analytics/scope` | Discover owned venue/account pairs and evidence asset codes. A truncated input is labeled partial. |
| POST `/analytics/conditional-settlement` | Provide `venue`, `account`, `asset`, `asOf`, distinct `yes` and `no` instrument IDs and decimal `unitPayout`. Returns an isolated user-declared calculation over existing selected quantities. |
| GET `/analytics/exposure` | Required `asset` and `asOf`; optional `venue` and `accounts`. Returns instrument/event exposure, concentration and allocation, payout scenarios, feasible joint extrema and constituent contributions, pending entitlements and the known resolution timeline. |

Unknown or out-of-portfolio account IDs are rejected. An omitted account filter means all known accounts. Choose explicit accounts when the workspace has multiple reporting assets or empty accounts. Each call uses one asset code with no implicit FX conversion, and the response never claims complete external-account coverage. Selective provider reads use portfolio and requested account IDs in SQL. Earlier activity stays in replay so opening state is reconstructed from the complete available input.

For example, a fractional TWR response of `{"value":"0.155","availability":"calculated","reason":null,"quality":"reconstructed_selected_value"}` represents 15.5%. A missing result carries a null value and a reason, e.g. `coverage_value_or_flow_boundary_missing`. A known valuation subtotal is separate from the aggregate selected value. Selected value may reflect estimated or declared evidence. No output implies that external-provider history was independently reconciled.

## Valuation, performance and attribution

- Historical replay uses event-time cutoffs and Phase 3 opening inventory, cash and mark eligibility. A later mark cannot support an earlier point. Active corrections are applied retrospectively. Market metadata in exposure comes from the current catalog, so the response does not reconstruct past catalog states. Calendar cutoffs are UTC. The engine computes endpoint and daily points, and optional sampling keeps weekly Sundays or month ends plus endpoints. History display sampling retains the requested endpoints. Daily, weekly and monthly returns are calculated independently from their opening and closing values and exact flow boundaries. Partial calendar periods are labeled. History points provide known interval and cumulative contributions, and investment gain when eligible.
- The requested opening instant includes events at that instant. Activity and flows are scoped to `(from, asOf]`. A valuation bridge compares endpoint values. Net investment gain subtracts classified net owner cash flows, with a coverage and classification requirement. Provider deposits and withdrawals lack independent investment-contribution classification and cannot automatically qualify.
- TWR values immediately before and after classified external flows, and links each end/start ratio. A nonpositive base, missing or stale valuation, incomplete coverage, or cash flow with another same-time event makes the affected return unavailable. A deposit alone is not gain. Annualized MWR uses dated investor cash flows with ACT/365, one sign change and a bracketed root between -99% and 10,000%; at most 64 nonzero payments. Cases outside those constraints remain unavailable.
- Drawdown is the drop from the prior peak of the flow-adjusted index sampled at the reported calculation cutoffs. Annualized volatility uses sample volatility of eligible consecutive daily intervals and multiplies by the square root of 365. The index, volatility and drawdown carry a reconstructed, carry-forward estimate, or unavailable quality label. No risk-free or benchmark series is assumed.
- Attribution uses posted realized ledger entries plus the change in known marked unrealized components at the two endpoints. It groups canonical instruments into events where possible and keeps unmapped components and the residual visible. The residual can include missing or non-attributed effects; it is not force-allocated.
- Trading counts use posted fills after reconciliation, with gross quantity-times-price notional. Attached charges, standalone charges and standalone rebates remain separate. Unknown attached fees are counted separately. Excluded records and duplicate source observations do not become extra trades.

## Exposure and settlement

- Allocation denominators contain known marked open positions in the selected asset and exclude cash. Missing marks are counted. Allocation and HHI can be read by instrument, market, event, venue and account. Unmapped rows are labeled and independent unmapped instruments are not equated across accounts.
- A settlement group requires an internally reviewed binary market rule, two canonical outcome IDs, an explicit collateral asset, unit payout to the winner and zero to the loser. It also requires eligible reconstructed quantities. Arbitrary CSV labels, market titles and thematic relationships establish no payout logic. Migration 0012 creates rule and relationship stores; neither is exposed for user writes. There are no preapproved live rules.
- A reviewed, oriented market-level relationship can establish equivalence, exclusion, or implication between YES outcomes. The engine expands connected reviewed markets, including unheld intermediary markets, then enumerates joint outcomes. Each connected component reports its evaluated coverage. If a component exceeds a bound, lacks an applicable bridge rule, or has contradictory constraints, the full calculation is unavailable and independently supported components retain a separate set of extrema. Standalone outcomes include joint feasibility within their evaluated component. Opposing holdings settle jointly in one scenario. Unsupported holdings are separately listed. No probability, expected payout or statistical correlation is inferred.
- Gross payout and mark-relative change are distinct. The worst feasible path shows additive leg contributions for that same path, rather than combining incompatible own worst cases. Cash-inclusive values require complete selected cash and eligible pending entitlements and a supported position set. Gross payout excludes cash and pending entitlements, which prevents double counting. Resolution buckets are based on event catalog schedule hints, with separate overdue and undated buckets. Per-market timing requires additional evidence. Pending entitlements stay in the ledger and schedule hints imply no redemption or cash date.

## Limits, measured workload and Phase 5 handoff

The performance endpoint supports up to 366 UTC date buckets, 18,000 scoped replays and 1.6 million scanned evidence rows per request. Endpoint balance and attribution use standard Phase 3 replay. Intermediate read models reuse independent venue/account projections until a source effect arrives, a mark expires, or a declaration ends. Replays read only the evidence prefix for a cutoff. A regression compares sampled projections to direct Phase 3 replay, including mark expiry and later evidence of an execution fee.

Run `node --import tsx scripts/benchmark-analytics.ts 364` from the backend directory. The benchmark contains 4,245 source rows, three accounts with 180 account/instrument pairs, dated historical marks, twelve deposit boundaries across a year, and 50 explicit exclusions. Separate local in-process runs produced the following observations. The 364-day result was rerun for the final hardening patch.

| Days | Effective rows at cutoff | Valuations | Cash-flow boundaries | Replay input rows | Time | RSS increase |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 742 | 32 | 1 | 5,770 | 75 ms | 6 MiB |
| 90 | 1,648 | 92 | 3 | 21,019 | 163 ms | 39 MiB |
| 180 | 2,557 | 182 | 6 | 49,178 | 290 ms | 37 MiB |
| 364 | 4,195 | 366 | 12 | 131,675 | 689 ms | 90 MiB |

These synthetic measurements exclude database, HTTP and concurrent load. The 364-day run produced a selected closing value of 33,776.50 and an eligible endpoint TWR; sparse marks still leave daily gaps.

### Additional coverage and eligibility

- Independently reviewed rule rows provide verified binary payout structure. Available native market metadata identifies outcomes and lifecycle, but currently supplies no structured proof of the full payout contract and exceptions. Open and closed unresolved markets can use a reviewed rule recorded by the cutoff. Resolved, unknown or unreviewed structures remain unsupported for ordinary binary enumeration. Pending ledger entitlements remain separate from open positions. Current catalog lifecycle is not a historical market record.
- Provider-reported exposure is returned separately from the effective ledger. Its rows include account, instrument, source record, observation and mark dates, membership and coverage. Only a recent row seen in the latest usable refresh by the cutoff enters reported settlement exposure. A fresh verified quantity of 100 at a timestamped mark of 0.60 yields a known value of 60 and reviewed payout alternatives of 0 and 100, even when acquisition history is unavailable. A stale or temporally unqualified mark cannot produce mark-relative downside. Partial refresh coverage is never presented as complete account coverage.
- Conditional settlement allows a member to supply one bounded binary declaration for an owned venue/account scope. It has a separate response and does not write catalog rules, affect the verified view, or accept cross-market assumptions. For example, an explicit two-unit payout applied to the demonstrated 80/100-share example produces a conditional range of 160–200. Unsupported positions in the verified view do not acquire payout rules from this calculation.
- Runtime response schemas cover performance, exposure and conditional results. Use the selected-account evidence digest with the exposure catalog digest and settlement evidence digest. Cash and observed exposure outside the selected denomination remain isolated. Sharpe, Sortino, correlation, reviewed native exceptions, and verified FX conversion remain evidence-dependent extensions.

### Component risk and fee scope

Reviewed constraints are decomposed into connected components, including unheld intermediary rules. Separate components can combine additive payout minima and maxima under the loaded rule model; this makes no statistical independence assumption. Bounds are 256 graph nodes, 1,000 constraints, 12 nodes per exact component and 32,768 total component states. Unavailable components include the implicated market IDs and the reason. Effective and reported graph limits are evaluated independently. Exact feasible counts are decimal strings when they exceed safe JSON integer precision. Thirty independent markets with 100 YES and 80 NO shares per market produce reference 2,760, gross payout 2,400–3,000, downside 360, and 1,073,741,824 feasible outcomes.

Fee analytics use explicit posted execution, standalone and funding effects from the Phase 3 ledger. A fee paid in ETH remains in ETH even if the trade settles in USD. Known charges, rebates, zero fees and unknown amounts are separate. Realized exit win rate considers only posted sales with known realized results; profit factor is unavailable without known loss observations. Attribution isolates unmapped instruments by venue and account and returns unavailable endpoint changes where either required endpoint component is missing.

Cash-inclusive allocation requires an authoritative opening inventory for every selected cash bucket, plus usable Phase 3 selected values, confirmed cash, marked open holdings and supported pending evidence. Cash-only evidence without an inventory declaration retains known cash and null weights. Negative cash or unavailable inputs disable percentage weights; the known bucket amounts remain visible. The reference 3,000/1,000 open exposure, 5,000 cash and 1,000 pending shows 75%/25% open allocation and 30%/10%/50%/10% cash-inclusive allocation. Acquisition basis uses separately labeled known position basis, with unknown positions counted.

The reusable calculation boundary is the pure performance, exposure and settlement modules. Phase 5 can build hypothetical constraints separately. Remaining integration work includes safe paginated record management when provider evidence exceeds the full-load cap, database/HTTP and concurrent benchmarking, broader verified payout structures, and historical catalog versioning. Full replay or impact previews still reject truncated provider input. Live-provider authorization and populated financial validation remain outstanding.

### API consumption and baseline revisions

Scope discovery identifies venue/account pairs and returns the observed evidence categories for each denomination, including fee denomination, declarations, marks and provider snapshots. Source-only observations establish discovery evidence for an asset. They do not establish eligibility for a selected valuation. Account allocation keys include both venue and account.

Performance returns include calendar-period posted fill counts, gross trade notional and posted fees by asset. Charges, rebates, missing amounts and observed zeros remain separate. Attribution reports the number of instruments lacking a usable unrealized change and retains the known subtotal. Fee and trade totals are limited to posted activity.

A baseline can store the exact analytical scope and as-of cutoff, the evidence and coverage revisions, and the exposure catalog, snapshot and reviewed-settlement revisions. A changed revision warrants an explicit baseline refresh or rebase. Phase 5 can call the pure calculations with scenario inputs while preserving the provenance and scope of the baseline. Historical catalog versioning, authoritative market-level resolution timing, permissioned native contract ingestion and production benchmarks remain integration work.

### Phase 5 contract details

Execution fee totals include posted effects denominated in the selected asset. The fee-to-notional ratio joins the fee to the same posted trade that contributes to notional. A compatible explicit zero or a posted rebate participates at its signed value. Unknown or incompatible fees on included trades make the ratio unavailable. Phase 3 resolves linked execution fee evidence before aggregation.

Performance and exposure use the same selected venue/account pairs. A missing selected-asset bucket leaves the aggregate unavailable. Known cash remains visible as a subtotal. Market and event concentrations use identified holdings only and report mapping coverage and known unmapped value separately.

A provider fill with a canonical source association can establish instrument identity. CSV rows can declare an existing catalog instrument by supplying its UUID in both `instrument` and the optional `canonical_instrument_id` column. The catalog lookup and declaration apply within the financial venue/account scope. An unassociated local identifier retains its local identity, including when its text matches an existing catalog UUID.

The binary settlement solver validates identities, denominations, quantities, marks and payout units before enumeration. Marks may be null, or decimals between zero and the payout unit. It reports exact modeled extrema with venue/account, market and instrument payoff contributions and jointly feasible outcomes. Unavailable results carry structured reasons and can include a separately qualified evaluated subset. Mathematical exactness describes the supplied model. Financial completeness and rule authority are reported by the enclosing analytical view.
