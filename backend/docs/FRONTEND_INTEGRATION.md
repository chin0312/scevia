# Frontend integration boundary

The backend API exposes stored facts and source coverage. It does not replace the frontend calculation layer from PR #1 and does not return derived P&L, portfolio value, event risk, or scenario results.

| Frontend need | Backend source | Integration note |
|---|---|---|
| Open positions | `/v1/portfolios/{id}/positions` | Returns only provider-authoritative current rows. Complete snapshots can remove absent positions after successful finalization; partial snapshots preserve the previous current holdings. Quantity, average cost, and mark are decimal strings; mark and average cost can be null. |
| Fills | `/v1/portfolios/{id}/fills` | Results include buy or sell direction, source time, fee amount, and fee status. Existing sample `OpenPosition.fills` only models buy lots, so the adapter must preserve sells and partial closes before mapping to `PortfolioData`. |
| Deposits and withdrawals | `/v1/portfolios/{id}/cash-movements` | The API uses signed amounts. Transfers and adjustments remain separate activity kinds. Do not sum missing history as zero. |
| Resolutions | `/v1/portfolios/{id}/settlements` | Payouts and quantities come from the provider. Do not assume a settlement always equals one or zero per share. |
| Cash | `/v1/portfolios/{id}/cash-balances` | Returns only current reported balances. A complete empty snapshot clears prior balances; partial snapshots do not. An explicit zero remains a known balance. |
| Freshness and availability | `/v1/portfolios/{id}/coverage` and `/sync-runs` | Coverage is per entity and separates observed record range, provider-confirmed interval, source-as-of, latest attempt, and latest successful sync. Ranges do not prove that every intervening record exists. Unsupported data is unavailable, not zero. |
| Market and event identity | Position and fill response metadata | Provider-native events remain distinct. A shared frontend `eventId` requires a reviewed event relationship. No automatic matching is included. |

A future loader should resolve the authenticated portfolio asynchronously and supply the selected portfolio to the existing `finance.ts` functions. The current frontend reads module-level sample data, so this work should follow PR #1 merge and update its `PortfolioData` types and calculations in a coordinated change. Keep `SAMPLE_PORTFOLIO` as an explicit sample mode.

`POST /v1/provider-accounts/{id}/sync` now returns an account summary with one result per configured stream; it no longer represents a portfolio account as one history run. The `/sync-runs` endpoint exposes stream name, pagination cursor and durable checkpoint boundaries, and whether a position/cash snapshot was finalized. Client code should present independent stream failures and use coverage attempt fields to distinguish a failed refresh from previously established data.

## PR #1 contract gaps to resolve before live frontend data

PR #1 remains open and unmerged. Its current `PortfolioData` calculations are sample-oriented and differ from the backend contract in ways that should be handled explicitly in a follow-up integration change:

| Frontend shape | Backend shape | Required integration decision |
|---|---|---|
| `number` for shares, prices, fees, and cash | Exact decimal strings backed by `NUMERIC(38,18)` | Do not convert blindly with `Number()`. Define the accepted calculation precision and rounding boundary or update calculations to preserve decimal arithmetic. |
| Open positions contain buy fills; closed trades are pre-aggregated | Fills include buy/sell direction and remain source records | Model partial exits and sells before mapping to the current `OpenPosition.fills` shape. |
| `feeKnown: boolean`; mark required as `number` | Fee status is `reported`, `estimated`, or `unavailable`; marks can be null | Preserve all three fee states and allow unavailable marks through UI calculations. |
| Binary `YES`/`NO` sides and frontend categories | Provider-native instruments can have multiple outcomes; category is not a provider fact | Keep provider market/outcome identity and add any user-facing classification as a separate reviewed field. |
| Date-only strings | UTC timestamps for records, observations, and source updates | Choose timezone-safe aggregation rules when producing frontend calendar dates. |
| Deposits and withdrawals only | Signed deposits, withdrawals, transfers, and adjustments | Keep transfer/adjustment kinds distinct from net deposits and performance. |

These are adapter and calculation-layer decisions, not changes to PR #1's current visual or calculation work. Backend PR #3 stays isolated to `backend/` and its own CI workflow; the root `.gitignore` and frontend files were left untouched.

Fees need a richer frontend type than a boolean once live data arrives. The API distinguishes `reported`, `estimated`, and `unavailable`, and only the unavailable state has a null fee amount. Position marks have their own timestamp and may be absent. Preserve those differences through any mapping instead of converting values to JavaScript numbers or filling them with zero.

Scenario inputs can eventually use normalized holdings and current marks, while the existing scenario engine remains the calculation owner. A missing mark must disable or qualify any scenario action that needs a current price. This phase does not expose a scenario endpoint.
