# Frontend integration boundary

The backend API exposes stored facts and source coverage. It does not replace the frontend calculation layer from PR #1 and does not return derived P&L, portfolio value, event risk, or scenario results.

| Frontend need | Backend source | Integration note |
|---|---|---|
| Open positions | `/v1/portfolios/{id}/positions` | Returns the latest stored provider position observations. Snapshot meaning is provider-specific: Polymarket is incremental and partial, so a missing row does not close an old holding. Zero-quantity rows are retained internally as tombstones and filtered from active holdings. Quantity, average cost, marks, provider status, redeemable/mergeable/archived flags and provider-reported values are distinct; decimals are strings and source mark time may be null. |
| Fills | `/v1/portfolios/{id}/fills` | Results include buy or sell direction, source time, fee amount, and fee status. Existing sample `OpenPosition.fills` only models buy lots, so the adapter must preserve sells and partial closes before mapping to `PortfolioData`. |
| Deposits and withdrawals | `/v1/portfolios/{id}/cash-movements` | The API uses signed amounts. Transfers and adjustments remain separate activity kinds. Do not sum missing history as zero. |
| Resolutions | `/v1/portfolios/{id}/settlements` | Payouts and quantities come from the provider. Do not assume a settlement always equals one or zero per share. |
| Unreconciled account events | `/v1/portfolios/{id}/activity-facts` | Includes typed facts such as redemptions, splits, merges, rewards and conversions when supplied by Polymarket. They are not reconciled settlements, transfers, or P&L. |
| Cash | `/v1/portfolios/{id}/cash-balances` | Returns only current reported balances. A complete empty snapshot clears prior balances; partial snapshots do not. An explicit zero remains a known balance. |
| Freshness and availability | `/v1/portfolios/{id}/coverage` and `/sync-runs` | Coverage is per entity and separates observed record range, outer bounds of reported intervals, source-as-of, complete-snapshot watermark, latest attempt, and latest successful entity retrieval. Bounds do not prove continuity across gaps. `lastSuccessfulSyncAt` stays unchanged for unknown/unavailable reports and for a complete snapshot that was rejected as stale. Unsupported data is unavailable, not zero. |
| Market and event identity | Position and fill response metadata | Provider-native events remain distinct. A shared frontend `eventId` requires a reviewed event relationship. No automatic matching is included. |
| Public market selection | `GET /v1/market-data/search?q=...` | No wallet connection is required. Results preserve provider event, market, and instrument IDs and can contain multiple outcomes/markets. Search is bounded to 10 events and 50 markets per response. |
| Paste market link | `POST /v1/market-data/resolve` | Only `https://polymarket.com/event/{slug}` and `/market/{slug}` are accepted. Event URLs can return several candidate markets. The user chooses the market/outcome; the API does not create a holding. |
| Reference history | `GET /v1/market-data/prices-history?tokenId=...` | Returns timestamped provider observations and resolution interval. CLOB midpoint fields have a Scevia retrieval time but no provider observation timestamp. They are reference values, not executable prices. |

A future loader should resolve the authenticated portfolio asynchronously and supply the selected portfolio to the existing `finance.ts` functions. PR #1 is building the expanded Scenario Lab and layout independently using its replaceable `MarketCatalog` and sample market data; it does not connect a Polymarket wallet or make live portfolio calls. After PR #1 merges, update `PortfolioData` types and loading/error/freshness states in a coordinated follow-up. Keep `SAMPLE_PORTFOLIO` as an explicit sample mode.

The development source flow is `POST /v1/portfolios` → `POST /v1/portfolios/{id}/sources/polymarket` → `POST /v1/provider-accounts/{id}/sync`. It tracks the explicitly entered Polymarket account wallet; it does not prove wallet ownership or infer a signer/funder address. `POST /v1/provider-accounts/{id}/sync` returns an account summary with one result per configured stream; the `/sync-runs` endpoint exposes stream name, pagination cursor and durable checkpoint boundaries, and whether a position/cash snapshot was finalized. Client code should present independent stream failures and use coverage attempt fields to distinguish a failed refresh from previously established data. The authenticated development principal is fixed by server configuration; it is not a production login contract.

For a complete authoritative snapshot, a saved cursor from an interrupted run is discarded and the next run starts at page one. Only pages from that new run can be published together. The API can therefore keep serving the previous current rows while a new snapshot is partial. Coverage bounds are an envelope over provider reports and must not be displayed as proof of continuous history or lifetime completeness.

## Future source and privacy experience

The schema can hold several provider accounts under one portfolio and treats an account as a source, not as the user's Scevia identity. A development-only portfolio creation and Polymarket source registration workflow exists. `file_import` exists as an account kind only; there is no upload, CSV parsing, import-batch reconciliation, production authentication, source disconnect, export, or delete API today. The frontend should not present those controls as available until backend contracts and lifecycle behavior are implemented.

The intended experience is an explicitly selected set of independently managed sources, such as a public wallet, a revocable read-only provider account, or an imported file. A public wallet address does not prove ownership. Future connection screens must distinguish address tracking from account authentication and must not request wallet private keys or seed phrases. For authenticated providers, verify actual read-only scopes and provider terms before enabling a connection. Stopping sync, disconnecting a provider, exporting retained records, and deleting records are separate actions that need explicit API semantics.

Portfolio data and source payloads are currently persisted in plaintext for backend services and database operators to process. No retention schedule, user export, or user deletion workflow is implemented. Backend documentation records that trust boundary; the UI should not promise that Scevia cannot access stored data or that users can erase it until production controls exist. Cross-device continuity also requires production user identity; reconnecting a wallet must never expose another user's saved workspace.

## Future public market lookup and Scenario Lab

The current market and instrument tables contain provider-native public metadata referenced by ingested records; they are not an indexed market catalog. The backend now offers stateless Polymarket search, supported event/market link resolution and bounded price history without requiring wallet information. Search uses Gamma event results/details; lookup accepts only recognized Polymarket URL forms and calls fixed provider API hosts. Public results do not create holdings. Future providers can implement their own search and link formats behind their provider-specific service.

Scenario Lab can later combine real holdings with selected public instruments, but hypothetical positions and saved scenarios need their own model and API. Keep them separate from provider-account snapshots so scenario edits never appear as real holdings or trigger synchronization. The existing frontend calculation layer remains the owner of calculations until a coordinated integration change defines any new contract.

## PR #1 contract gaps to resolve before live frontend data

PR #1 remains open and unmerged. Its Scenario Lab market-selection flow is sample-oriented; actual wallet loading and the following `PortfolioData` differences should be handled in a coordinated integration change:

| Frontend shape | Backend shape | Required integration decision |
|---|---|---|
| `number` for shares, prices, fees, and cash | Exact decimal strings backed by `NUMERIC(38,18)` | Do not convert blindly with `Number()`. Define the accepted calculation precision and rounding boundary or update calculations to preserve decimal arithmetic. |
| Open positions contain buy fills; closed trades are pre-aggregated | Fills include buy/sell direction and remain source records | Model partial exits and sells before mapping to the current `OpenPosition.fills` shape. |
| `feeKnown: boolean`; mark required as `number` | Fee status is `reported`, `estimated`, or `unavailable`; marks can be null | Preserve all three fee states and allow unavailable marks through UI calculations. |
| Binary `YES`/`NO` sides and frontend categories | Provider-native instruments can have multiple outcomes; category is not a provider fact | Keep provider market/outcome identity and add any user-facing classification as a separate reviewed field. |
| Date-only strings | UTC timestamps for records, observations, and source updates | Choose timezone-safe aggregation rules when producing frontend calendar dates. |
| Deposits and withdrawals only | Signed deposits, withdrawals, transfers, and adjustments | Keep transfer/adjustment kinds distinct from net deposits and performance. |

These are adapter and calculation-layer decisions, not changes to PR #1's current visual or calculation work. Phase 2A implements backend read-only lookup and ingestion; Phase 2B remains asynchronous wallet loading, source freshness/partial states, and wiring real search/link results into Scenario Lab after PR #1 merges.

Fees need a richer frontend type than a boolean once live data arrives. The API distinguishes `reported`, `estimated`, and `unavailable`, and only the unavailable state has a null fee amount. Position marks have their own timestamp and may be absent. Preserve those differences through any mapping instead of converting values to JavaScript numbers or filling them with zero.

Scenario inputs can eventually use normalized holdings and current marks, while the existing scenario engine remains the calculation owner. A missing mark must disable or qualify any scenario action that needs a current price. Polymarket's midpoint reference has no provider timestamp; its trade `price` and CLOB midpoint are different price types. Hypothetical selections stay in frontend scenario state and never write to actual provider holdings. This phase does not expose a scenario persistence endpoint.
