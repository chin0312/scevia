# Frontend integration boundary

The backend API exposes stored facts and source coverage. It does not replace the frontend calculation layer from PR #1 and does not return derived P&L, portfolio value, event risk, or scenario results.

| Frontend need | Backend source | Integration note |
|---|---|---|
| Open positions | `/v1/portfolios/{id}/positions` | Returns active provider-authoritative current rows. Zero-quantity current rows are retained internally as closure tombstones for ordering and are filtered from this endpoint. Complete snapshots can remove absent positions after successful finalization; partial or stale snapshots preserve prior holdings. Quantity, average cost, and mark are decimal strings; mark and average cost can be null. |
| Fills | `/v1/portfolios/{id}/fills` | Results include buy or sell direction, source time, fee amount, and fee status. Existing sample `OpenPosition.fills` only models buy lots, so the adapter must preserve sells and partial closes before mapping to `PortfolioData`. |
| Deposits and withdrawals | `/v1/portfolios/{id}/cash-movements` | The API uses signed amounts. Transfers and adjustments remain separate activity kinds. Do not sum missing history as zero. |
| Resolutions | `/v1/portfolios/{id}/settlements` | Payouts and quantities come from the provider. Do not assume a settlement always equals one or zero per share. |
| Cash | `/v1/portfolios/{id}/cash-balances` | Returns only current reported balances. A complete empty snapshot clears prior balances; partial snapshots do not. An explicit zero remains a known balance. |
| Freshness and availability | `/v1/portfolios/{id}/coverage` and `/sync-runs` | Coverage is per entity and separates observed record range, outer bounds of reported intervals, source-as-of, complete-snapshot watermark, latest attempt, and latest successful entity retrieval. Bounds do not prove continuity across gaps. `lastSuccessfulSyncAt` stays unchanged for unknown/unavailable reports and for a complete snapshot that was rejected as stale. Unsupported data is unavailable, not zero. |
| Market and event identity | Position and fill response metadata | Provider-native events remain distinct. A shared frontend `eventId` requires a reviewed event relationship. No automatic matching is included. |

A future loader should resolve the authenticated portfolio asynchronously and supply the selected portfolio to the existing `finance.ts` functions. The current frontend reads module-level sample data, so this work should follow PR #1 merge and update its `PortfolioData` types and calculations in a coordinated change. Keep `SAMPLE_PORTFOLIO` as an explicit sample mode.

`POST /v1/provider-accounts/{id}/sync` now returns an account summary with one result per configured stream; it no longer represents a portfolio account as one history run. The `/sync-runs` endpoint exposes stream name, pagination cursor and durable checkpoint boundaries, and whether a position/cash snapshot was finalized. Client code should present independent stream failures and use coverage attempt fields to distinguish a failed refresh from previously established data.

For a complete authoritative snapshot, a saved cursor from an interrupted run is discarded and the next run starts at page one. Only pages from that new run can be published together. The API can therefore keep serving the previous current rows while a new snapshot is partial. Coverage bounds are an envelope over provider reports and must not be displayed as proof of continuous history or lifetime completeness.

## Future source and privacy experience

The schema can hold several provider accounts under one portfolio and treats an account as a source, not as the user's Scevia identity. `file_import` exists as an account kind only; there is no upload, CSV parsing, import-batch reconciliation, production authentication, source-management, export, or delete API today. The frontend should not present those controls as available until backend contracts and lifecycle behavior are implemented.

The intended experience is an explicitly selected set of independently managed sources, such as a public wallet, a revocable read-only provider account, or an imported file. A public wallet address does not prove ownership. Future connection screens must distinguish address tracking from account authentication and must not request wallet private keys or seed phrases. For authenticated providers, verify actual read-only scopes and provider terms before enabling a connection. Stopping sync, disconnecting a provider, exporting retained records, and deleting records are separate actions that need explicit API semantics.

Portfolio data and source payloads are currently persisted in plaintext for backend services and database operators to process. No retention schedule, user export, or user deletion workflow is implemented. Backend documentation records that trust boundary; the UI should not promise that Scevia cannot access stored data or that users can erase it until production controls exist. Cross-device continuity also requires production user identity; reconnecting a wallet must never expose another user's saved workspace.

## Future public market lookup and Scenario Lab

The current market and instrument tables contain provider-native public metadata referenced by ingested records. They are not a market catalog, and there is no account-independent search or lookup endpoint. Future market discovery should use a provider adapter that can query public metadata without creating fake portfolio holdings. A supported URL flow should parse an allowlisted provider URL to a provider ID and call a trusted configured API; it must not perform arbitrary URL fetching or website scraping.

Scenario Lab can later combine real holdings with selected public instruments, but hypothetical positions and saved scenarios need their own model and API. Keep them separate from provider-account snapshots so scenario edits never appear as real holdings or trigger synchronization. The existing frontend calculation layer remains the owner of calculations until a coordinated integration change defines any new contract.

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
