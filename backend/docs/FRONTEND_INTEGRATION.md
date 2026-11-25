# Frontend integration boundary

The backend API exposes stored facts and source coverage. It does not replace the frontend calculation layer from PR #1 and does not return derived P&L, portfolio value, event risk, or scenario results.

| Frontend need | Backend source | Integration note |
|---|---|---|
| Open positions | `/v1/portfolios/{id}/positions` | Quantity, average cost, and mark are decimal strings. Mark and average cost can be null. Keep provider, market, and instrument identity with each row. |
| Fills | `/v1/portfolios/{id}/fills` | Results include buy or sell direction, source time, fee amount, and fee status. Existing sample `OpenPosition.fills` only models buy lots, so the adapter must preserve sells and partial closes before mapping to `PortfolioData`. |
| Deposits and withdrawals | `/v1/portfolios/{id}/cash-movements` | The API uses signed amounts. Transfers and adjustments remain separate activity kinds. Do not sum missing history as zero. |
| Resolutions | `/v1/portfolios/{id}/settlements` | Payouts and quantities come from the provider. Do not assume a settlement always equals one or zero per share. |
| Cash | `/v1/portfolios/{id}/cash-balances` | Only reported balance snapshots appear. No balance is returned when the provider does not expose one. |
| Freshness and availability | `/v1/portfolios/{id}/coverage` and `/sync-runs` | A stale or partial source needs an explicit UI state beside the number it qualifies. Unsupported data is unavailable, not zero. |
| Market and event identity | Position and fill response metadata | Provider-native events remain distinct. A shared frontend `eventId` requires a reviewed event relationship. No automatic matching is included. |

A future loader should resolve the authenticated portfolio asynchronously and supply the selected portfolio to the existing `finance.ts` functions. The current frontend reads module-level sample data, so this work should follow PR #1 merge and update its `PortfolioData` types and calculations in a coordinated change. Keep `SAMPLE_PORTFOLIO` as an explicit sample mode.

Fees need a richer frontend type than a boolean once live data arrives. The API distinguishes `reported`, `estimated`, and `unavailable`, and only the unavailable state has a null fee amount. Position marks have their own timestamp and may be absent. Preserve those differences through any mapping instead of converting values to JavaScript numbers or filling them with zero.

Scenario inputs can eventually use normalized holdings and current marks, while the existing scenario engine remains the calculation owner. A missing mark must disable or qualify any scenario action that needs a current price. This phase does not expose a scenario endpoint.
