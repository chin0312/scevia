# Development notes

Internal state of the codebase: what exists, what doesn't, known limitations, and how real data will plug in. The public introduction is `README.md`; calculation rules are in `docs/METHODOLOGY.md`.

_Last updated: 2026-11-25_

## Current state

- **Frontend:** all four modules are built (Overview, Analytics, Risk, Scenario Lab). It is a dark-only design system enforced by lint.
- **Data:** a deterministic **sample portfolio** (`web/src/data/sample.ts`), the development `fixture` workspace, used for exploring and tests. There is no backend connection, no auth and no account connections. The Demo portfolio is selectable but reports itself unavailable until the backend demo (`/v1/demo`, PR #8) is connected.
- **Workspace boundary:** `data/workspace.ts` (`WorkspaceService`, contract readers) + `lib/workspaceContext.tsx` (selected workspace, revisions, per-stream freshness, refresh). See *Workspace boundary and integration handoff* below.
- **Portfolio workspace:** `/portfolio/:section` organizes accounts, sources, transactions, imports & reconciliation and data coverage. Its records are an isolated sample of record management; they never change portfolio figures.
- **Calculations:** one pure module (`web/src/lib/finance.ts`) with 50+ unit tests. Scenario bookkeeping is in `web/src/lib/scenarios.ts`.
- **Persistence:** scenarios (with their fee treatment and constraints) and the guardrail are kept in `sessionStorage` (one browser tab) through `lib/storage.ts`.
  - Only `scevia-`-prefixed keys are used and cleared.
  - Reads are validated (`scenarios.sanitize`), and dangling position references are dropped.
  - Write failures surface in the UI.
- **Interaction infrastructure:**
  - shared detail panels with an origin scope (`components/details.tsx`);
  - an overlay layer stack: topmost-only Esc, inert layers underneath, one scroll lock (`components/overlays.tsx`);
  - one-time scenario hand-off requests (`lib/handoff.ts`);
  - `scrollToSection()` for programmatic jumps through the section rail.
- **Tests:**
  - Vitest (`npm test`), covering ledger identities, periods, attribution, relationships and feasibility, mixed-side event exposure, enumeration bounds, scenarios, scenario lifecycle and state restore;
  - Playwright (`npm run test:e2e`), covering user journeys: hand-offs, scope, overlays, allocation, the rail, and phone/tablet overflow;
  - GitHub Actions runs lint, design checks, unit tests, build and e2e on PRs.

## Known limitations

- **Data:**
  - sample data only; Portfolio › Sources shows connections as unavailable (buttons are disabled, not simulated);
  - intermediate historical marks are synthetic paths between real anchors (first fill → previous visit → today);
  - drawdown and the value chart use weekly snapshots;
  - closed-trade fees are recognised at close; trades can't be partially closed in the history model (a closed trade is one round trip).
- **Fees:**
  - Hypothetical fees use the published formulas with sample per-market parameters (`data/sampleFees.ts`).
  - Kalshi figures are from secondary summaries of the official schedule, which was unreachable from our network; re-verify them.
  - Historical sample fees are fictional records.
- **Scenarios:**
  - no slippage or order-book depth;
  - the assumed fill price is applied to the whole size.
- **Relationships:**
  - Source relationships carry provenance; only verified ones constrain Risk.
  - Scenarios may add hypothetical mutex/equivalent constraints.
  - Equivalent contracts share an `eventId` (settlement group).
  - No multi-market constraint types (e.g. negative-risk sets) yet.
- **Outcomes:**
  - binary YES/NO only, settling at $1/$0;
  - mixed YES and NO holdings on one event are netted correctly (METHODOLOGY);
  - multi-outcome markets and non-$1 settlements are not modelled.
- **Feasible-outcome engine:**
  - exhaustive and exponential;
  - capped at 16 events; above that, ranges are unavailable;
  - needs a bounded method before unrestricted real portfolios.
- **Persistence:** browser tab only (no accounts, no cloud). The guardrail is a single per-event limit.
- **Scenario positions:**
  - Held positions are keyed by position id.
  - New instruments are keyed by `provider:marketId:outcome` and carry an `InstrumentRef`.
  - Market search and link resolution use the **sample market catalog** (`data/sampleMarkets.ts`), behind the `MarketCatalog` interface (`lib/markets.ts`).
- **Platforms:** sample instruments are limited to the `pm`/`ks` platform union.
- **Detail panels** aren't URL-addressable; a reload closes them.
- **Layout:**
  - fluid desktop up to 2560px;
  - tablet and phone widths reflow and are covered by e2e overflow checks;
  - no dedicated mobile design yet.
- **Lint:** remaining oxlint warnings are React Compiler advisories (fast-refresh boundaries; setState in effects for URL/input sync).

## Technical debt

- `lib/finance.ts` reads the portfolio as module-level constants (`data/portfolio.ts`). This is fine for a synchronous fixture, but real data will be async and per-user. Next step: pass `PortfolioData` explicitly (or via React context) and memoise derived values per portfolio.
- Event grouping relies on `eventId` provided by the data. Cross-platform matching rules don't exist yet.
- Some pages compute a lot in render (`series()` per filter). It's fast for the sample; profile it with real history sizes.

## Data boundaries to keep

These are separate concepts today and must stay separate when persisted:
- **Portfolio records.** Source data, read through `data/portfolio.ts`. The backend owns ingestion; see `backend/docs/FRONTEND_INTEGRATION.md` in PR #3.
- **Analytical assumptions.** The guardrail (shared). Fee treatment and hypothetical constraints belong to each scenario.
- **Scenarios.** `lib/scenarios.ts`, pure; hypothetical only.
- **Source configuration.** Which sources a user selected; not built yet.

A future authorized workspace persists the last three per user. Portfolio records stay owned by sources and imports.

## Scenario Lab: what exists, what Phase 2/5 replace

**Built (Phase 0):**
- an entry page (`lab/Home.tsx`): *Modify current portfolio* (with a preview of what is inherited) and *Build from scratch* (with optional starting capital per venue), saved-scenario cards, optional examples; no empty charts before a scenario exists;
- an active scenario in three views sharing one state (`ScenarioLab.tsx`): **Build** (setup, positions, live cash & value summary), **Analyze** (`lab/Analyze.tsx`: summary, value bridge, settlement range, allocation, event exposure, resolution timeline, outcome matrix, payoffs, position detail), **Compare** (`lab/Compare.tsx`: pick scenarios, bases, charts, detailed table);
- essentials inline (starting portfolio, capital); fees, constraints and methodology in an assumptions drawer, summarized in one line;
- sizing by shares, $ amount or % of starting value (`Adjustment.size`, `targetShares`), fractional quantities (0.01 step);
- multi-select Add markets (holdings / search with filters / paste link), one selection per instrument across tabs;
- bulk actions with distinct semantics: *Remove from scenario* (restores the holding), *Set target to 0* (simulates an exit), *Reset to current size*, *Use reference prices*, with undo;
- per-scenario fee treatment and hypothetical settlement constraints; feasibility followed through linked constraints (`partialFeasible`);
- comparison against each scenario's own start, with funding compared per venue;
- migration from older stored scenarios (`scevia-scenarios-v3` → `-v4`); `baseAsOf` and `size` added without a new key (older entries read as unknown / shares).

**Data boundary:**
- `MarketCatalog` (`lib/markets.ts`), with `search(query, {provider})` and `resolveLink(url)` returning a `LinkResolution`.
- `data/markets.ts` picks the implementation; today `fixtureCatalog(SAMPLE_MARKET_EVENTS)`.
- The UI never imports the fixture directly and never fetches a pasted URL. `parseMarketLink` only recognises supported hosts.

**Frontend expectations for Phase 2 (market lookup + link resolution).** These are not a finalized API; verify against Polymarket's documentation and responses first.

| Need | Expectation |
|---|---|
| Search | Server-side search over public market metadata. Optional provider filter. Paginated. Returns events with markets and outcomes. |
| Link resolution | A backend endpoint takes the pasted URL and returns `resolved` / `not-found` / `unsupported` / `unavailable` (same states as `LinkResolution`). The browser sends the URL only to Scevia's backend. |
| Identity | Provider-native `externalEventId`, `externalMarketId`, outcome `externalId` / token id (backend `NormalizedMarket`). The frontend's `marketId` / `outcome` map to these. A position id is account-specific; held positions are matched to instruments by provider + market + outcome, so multiple accounts holding the same contract stay distinct positions. |
| Prices | Reference price per outcome as a **decimal string**, with `observedAt` (UTC) and `priceKind`. It may be null; the UI then requires a typed price and shows value as unavailable. |
| Lifecycle | Market and event lifecycle (open / closed / resolved) and resolution rules or settlement terms. Closed or resolved markets can't be added. |
| Outcomes | Binary YES/NO today. The response should list all outcomes, so multi-outcome markets can be shown and, later, modelled. |
| Fees | Per market: the provider's fee parameters, as decimal strings and with nothing silently defaulted (Phase 2 returns Polymarket `feeRateBps`, nullable). Also the fee type (taker-only vs. maker+taker), the rounding rule, and the schedule's **source and effective date**. Missing parameters are shown as unavailable. The frontend never keeps its own copy of provider fee schedules. |
| Execution role | Maker/taker can't be known in advance, so it stays a scenario assumption. The backend should say which roles a market charges. |
| Fee mapping (Phase 2, merged in #4) | Gamma fee facts map onto `FeeSchedule` as follows:<br>• `fee_free` → taker 0, maker 0.<br>• `known` → taker = rate, maker = 0 (taker-only semantics).<br>• `incomplete` / `unknown` → `null` (shown as unavailable).<br>A supplied exponent other than 1 must also map to unavailable until `estimateFee` supports it; never approximate. Carry source and retrieval time into `reference` / `effective`. Rebates stay out of scenario fees unless the user models them explicitly. These are schedules for hypothetical trades only, never historical fills. |
| Relationships | Verified settlement facts only, with provenance. Examples: Polymarket `negativeRisk` events (at most one market resolves YES), equivalent contracts after review, payout rules per outcome. Unreviewed similarity is never a constraint. |
| Settlement groups | Which contracts settle together comes from **reviewed** relationships, never title matching. |

**Phase 5 (real-data scenario construction):**
- load the user's **effective** portfolio (after reconciliation decisions) asynchronously as the "current portfolio" start; never excluded records or not-seen provider rows as confirmed holdings; say which hypothetical calculations remain possible when starting quantities, cash or costs are unknown;
- key scenario cash by **account** (today: by venue, one sample account each) and give each new purchase a destination account or standalone funding scope;
- persist scenarios per user (workspace), including instrument refs and the reference price/time used;
- replace fixed `pm`/`ks` with provider ids;
- use real fees;
- replace the 16-event cap with a bounded exact method.

## Accounts, venues, sources and identity

The frontend now distinguishes (types in `data/types.ts`, sample in `data/sample.ts`):

| Concept | Frontend | Notes |
|---|---|---|
| Portfolio | `PortfolioData` | The user-selected set of accounts. |
| Financial account | `AccountRef {id, venue, label, kind, sources}`; `OpenPosition.accountId`; `Holding.accountId` | One wallet or venue login. Several can share a venue. |
| Venue | `Platform` (`pm` / `ks`) | Where positions are held. Still a fixed pair in this build. |
| Acquisition source | `AcquisitionKind` (`api` / `csv` / `manual`) | How records arrive. CSV is not a venue; Predexon would be a source, not an exchange. |
| Market / outcome instrument | `InstrumentRef` (`provider:marketId:outcome`) | Provider-native identity. |
| Account-specific holding | `Position.id` | Two accounts holding the same instrument are two positions. |

- `holdingsOfInstrument(i)` returns every account's holding of an instrument; `positionFor(i)` returns one only when exactly one account holds it, never "the first". The Add markets dialog lists holdings per account; a searched instrument held in several accounts is added as a new purchase (the user picks the account under *Your holdings* to change an existing one).
- Scenario cash is still per **venue**. With one sample account per venue this equals the account; Phase 5 must key cash by account (see above).

## Accounting ownership

The backend replay (Phase 3, PR #5) is the authority for actual portfolio results: weighted-average cost with acquisition fees in basis, decimal arithmetic, settlement entitlements separate from cash, provider observations vs. reconstructed vs. user-declared values, and per-metric availability. The frontend keeps:
- `lib/finance.ts` calculations over the **sample** ledger (now on the same cost-basis convention), and
- the scenario engine (`simulate`) for immediate hypothetical interactions.

It must not build a second actual ledger. Phase 4 integration maps replay results (holdings, cash by account and asset, realized/unrealized with availability, discrepancies, coverage) onto the presentation model; unknown values stay unavailable, and a known subset is never shown as a verified total. Differences that remain are listed in `docs/METHODOLOGY.md › Account figures`.

## Portfolio workspace and record management (sample)

`/portfolio/:section` (`pages/Portfolio.tsx`) is the one place for portfolio management; `/accounts` redirects there and the old Data sources modal is gone (`useConnect()` now navigates). Accounts, sources and coverage describe the sample portfolio; transactions and imports run on an isolated record-management sample (`data/sampleRecords.ts`, `lib/records.ts`, `lib/useWorkspace.ts`, key `scevia-records-v2`, validated per record).

| Backend contract (ACCOUNTING.md, Phase 3) | Sample workspace |
|---|---|
| Account UUIDs independent of labels | Stable `id`s (`acc-…`); labels are editable and may repeat; venue chosen explicitly |
| Import preview + confirm, `acceptUnlinked` | Import flow: file → account (existing or new, with venue) → supplement / independent → preview (overlaps, unreported fees, carried decisions) → confirm → result; a local notification |
| Stable batch ids; `replaces` with decision carry-over by stable event id | Keys are `batchId#row`; the same file into another account never collides; the same file into the same account is a replacement that supersedes the batch and carries decisions by source reference |
| `GET /accounting/records` filters | Search, account, venue, source, type, status (incl. corrected, any decision), batch, dates, duplicates; filters live in the URL so accounts and imports link to them |
| Filtered selection with `except`, preview, revision, atomic confirm | Select row / page / all matching; any filter change (controls, Back/Forward, search) clears the selection and says so; the preview also lists records changed indirectly (duplicates of a changed original) and those that will need review, applies no decision to them, and includes them in the effects; preview lists selected, changing and unchanged records, accounts, unknown amounts, cash per account and shares per account + market + outcome |
| Membership `include` / `exclude` / `restore`; `reset_correction` / `reset_identity` / `reset_duplicate` / `reset_all`; `distinct`; `duplicate` pins a target revision | Same dimensions and actions. A link can only be made to an included original and stores its economic fingerprint; it holds only while the original is included and unchanged, otherwise the duplicate needs review. Replacement rows whose source values changed carry only an exclusion and need review. |
| Manual records (shared storage, separate quota) | Add record: any account (incl. connected), catalog market or local instrument, explicit YES/NO, buy/sell, date-time, fee or "unknown" |

Stored state is validated per record (unknown keys or invalid values in a correction drop the correction, not the record; unknown batch references are cleared). The in-memory workspace stays authoritative if a storage write is refused, and the page says changes aren't being saved. Account names come from one helper (`accountName`) so a rename shows everywhere.

Integration replaces `lib/records.ts` with API calls (keeping the UI states), binds confirmations to the returned review revision, handles 409 by re-previewing, and swaps the simple previews for the backend's before/after holdings and cash.

## Phase 4 and Phase 5 presentation contracts

- **Availability.** Every figure that comes from the backend carries a state: known, partial (known components), estimated, user-declared, provider-reported, reconstructed, stale or unavailable. The UI keeps these words (Portfolio › Data coverage lists them) and never shows unavailable as $0.
- **Scope.** Analytics read a scope (accounts, denomination asset, date range). Page filters stay views; provider-reported and reconstructed views are labelled separately. No cross-asset sums without conversion.
- **Performance (ANALYTICS.md).** Daily/weekly/monthly series with availability, time- and money-weighted returns, flow-adjusted index, drawdown, contributions. A missing interval is a gap in the chart. The sample Analytics keep their current figures and don't synthesize these metrics.
- **Risk.** Exposure from selected ledger results and, separately, the provider snapshot; reviewed settlement structures with exact vs. bounded ranges; user-declared payouts only in a conditional view; verified facts never mixed with scenario constraints.
### Phase 5 scenario handoff (reference: PR #7, `backend/docs/SCENARIOS.md`)

The backend scenario engine becomes the authority for integrated scenario results; the frontend keeps the Scenario Lab UI, sample evaluation for immediate feedback until the switch, and never runs a second persistence system. Mapping:

| Backend concept | Frontend today (sample) | Integration |
|---|---|---|
| Frozen baseline token (`POST /baseline`, 15 min) and `weighted-average-scenario-v1` snapshot | `baseline` + `baseAsOf` date; evaluates against the current sample | "Modify current portfolio" previews a baseline and saves with its token; the scenario shows its baseline cutoff. Evaluation never replays the current portfolio. |
| Account-specific funding buckets (venue/account), no inter-bucket transfers | Capital per venue, mapped to that venue's single account (shown in setup) | Capital inputs and the Cash & value summary become per bucket; a purchase picks a bucket; shortfalls are per bucket. |
| `hypothetical:` buckets (starting capital, added capital, assumed missing cash as separate fields) | "Build from scratch" with capital per venue | Scratch scenarios create hypothetical buckets; the three capital fields get separate inputs and labels; actual accounts untouched. |
| `captureCurrentQuote` (retrieval time, mixed-quote flag) | Sample reference prices with an as-of date; "Use reference" fills the assumed price | Adding a market can freeze its current public quote; rows show quote time and a "mixed current quote" label when retrieved after the cutoff. User mark overrides and execution prices stay separate fields. |
| Saved revisions; PATCH with current revision; 409 on stale writes | Save / Revert / Reset in this tab | Save sends the revision; a 409 shows "changed elsewhere" with reload or save-as-copy; no silent overwrite. |
| Conditional payout model (declared payouts, extra constraints, outcome selections) as an independent view | Hypothetical constraints in the assumptions drawer | Constraints and declared payouts move to the conditional view, labelled as such; they never change reviewed rules. |
| Verified (reviewed rules) vs. hypothetical constraints | `verified` / `annotation` / `hypothetical` provenance | Verified facts come from reviewed rules and are read-only; hypothetical ones stay per scenario. |
| Rebase preview: holdings, cash, instrument and rule differences, indexed operation conflicts; confirm with token + revision; optional rebased copy | `baseAsOf` notice when the portfolio date differs | "Rebase…" opens a diff with conflicts per operation; the user resolves, then confirms, or keeps the original via a rebased copy. Never automatic. |
| Comparison compatibility (baseline, account scope, valuation, budget, funding, fee method, settlement scope, asset) | `assumptionKey` flags differing setups; change from own start; % of own start when positive | Show each compatibility field the API returns; normalized change only with an eligible positive budget; incompatible assets flagged, never summed. |
| Independent availability (funding, quantities, valuation, basis, P&L, fees, settlement) | Nullable metrics; "Unavailable" never $0 | Each figure reads its own availability; one unavailable part doesn't blank the rest. |
| `knownAdditionalCapitalRequired` vs. complete requirement | "Needs $X more" (sample cash always known) | Show "at least $X more" when the complete requirement is unavailable, and the exact figure only when it's complete. |
| Exact vs. bounded settlement coverage; event dates as schedule hints | 16-event exact enumeration; "scheduled resolution" wording | Show the covered subset and unsupported holdings; keep schedule-hint wording and unknown dates. |


## Workspace boundary and integration handoff (roadmap Issue #2, Phases 0–11)

Backend Phases 1–6 (PRs #3–#8) and the Phase 7 continuous-tracking foundation (PR #9, `02c3248`) are merged on `main`; see `backend/docs/PHASE7_HANDOFF.md`, `CONTINUOUS_TRACKING.md` and `DATA_ACQUISITION_STRATEGY.md`. Roadmap (Issue #2): **Phase 7** Real Data & Continuous Portfolio Tracking Foundation (technical foundation merged; real-data and financial acceptance outstanding), **Phase 8** Historical Replay Engine, **Phase 9** Real Data Acquisition & Validation, **Phase 10** Unified Product Integration & Internal QA, **Phase 11** Secure Release & Free Public Beta. This frontend is not formally integrated; formal integration (Phase 10) requires the Phase 9 real-data acceptance gate, not only mocked or synthetic backend results.

### Workspace isolation (implemented)

- **Identity and status** come from `WorkspaceService` (`data/workspace.ts`) through `WorkspaceProvider` / `useActiveWorkspace()`: id, mode (`fixture` / `demo` / `actual`), revisions, per-stream freshness, load and refresh state. A late response from an earlier selection is ignored (request counter); a failed refresh keeps the last usable data, marked as not refreshed (`reason: 'refresh_failed'`).
- **Financial read model** is per workspace: `createFinance(data)` (`lib/finance.ts`) bound to the selected workspace's `PortfolioData` and provided by `FinanceProvider` / `useFinance()` (`lib/financeContext.tsx`). No page reads a global portfolio; `lib/boundary.test.ts` fails if a page, component or shared library imports fixture data or `lib/fixtureFinance.ts` (the fixture-bound instance for the fixture service and tests).
- **Without data** (loading, unavailable, failed, not connected) a workspace gets an **empty** portfolio (`hasPortfolio: false`): Overview, Analytics, Risk and Portfolio show the workspace state; Scenario Lab still builds from scratch and replays history with virtual capital. The Sample portfolio is never a fallback.
- **Workspace-owned storage** uses `scopedKey(base, workspaceId)` → `base@<id>` (the development Sample keeps its original unsuffixed keys): scenarios, active scenario, replays, records (`useWorkspace.ts`, one store per workspace), local activity events and notification read state. Global preferences (settings, view choices, selected workspace) stay unscoped. `useSessionState` re-reads when its key changes, so one workspace's value is never written under another's key.
- **Pages remount per workspace** (keyed outlet and detail panels), so filters, selections and open panels never carry across portfolios; a refresh of the same workspace keeps them.
- **Development service** (`data/devWorkspaces.ts`): only in development builds and only when a tab sets `scevia-dev-workspaces` (or opens `?devWorkspaces=1`). It adds Development fixture B (different account, PUSD, holdings, cash, history and records; slow to load), C (fails to load) and D (refresh fails). `e2e/isolation.spec.ts` uses it. It isn't in production bundles.

### Status by area

| Area | Working frontend interaction | Development fixture behaviour | Backend implemented (main) | Backend still required | Formal integration (Phase 10) |
|---|---|---|---|---|---|
| Workspaces | Selector (Sample / Demo / My portfolios), per-workspace read model, keyed storage, stale-response guard, gate states | Sample = fixture; Demo always unavailable; no actual portfolios | `GET/POST /v1/portfolios` (`mode`), parsed by `readPortfolioList` | — | API-backed `WorkspaceService`; *Create portfolio* |
| Demo portfolio | Explicit unavailable state; no fixture fallback | Unavailable | `/v1/demo` initialize / resume / reset / refresh (revision, 409), quotes with source time vs. retrieval (`readDemo`, `demoStreams`) | Approved real capture (Phase 6B) | Initialize / resume / reset / refresh actions |
| Freshness | Independent streams; refresh with retry and failure state; future/invalid times unavailable; clock-skew tolerance; development age thresholds labelled as such (`classifiedBy`) | Fixture streams "Fixed sample" / unavailable | `/coverage`, `/sync-runs`, account sync, quote freshness | Scheduled acquisition, incremental sync and revaluation: merged foundation (PR #9); authorized sources and acceptance in Phase 9 | Map backend classifications and measured cadence onto streams |
| Overview / Analytics / Risk | Workspace-bound figures; valuation basis, native amounts, reporting note only when assets mix; periods gated by the workspace's history | Fixture ledger and weekly sample marks | Strict accounting, `/analytics/performance` (carry-forward reference estimates, stale counts, return eligibility), `/analytics/exposure`, `/analytics/denominations` | Continuous valuation: merged foundation (PR #9); validated in Phase 9 | Replace fixture calculations with read models; plot carried values as estimates and keep gaps before a first mark |
| Current-market scenarios | Frozen vs. latest vs. assumed price check (latest from the workspace's marks or the market service; missing latest ≠ unchanged); virtual starting / additional capital with shortfall cover; scenarios per workspace | Local evaluation on the fixture or an empty portfolio | Baseline tokens, `captureCurrentQuote`, evaluate, revisions/409, rebase preview, mixed-denomination evaluation | — | Baseline → evaluate → save; rebase preview from the API |
| Historical Replay | Build · Analyze · Compare; trading open/close vs. expected/verified resolution; virtual funding buckets (venue + asset, freely editable, shortfall cover); funded / unfunded / unknown; unknown fees never zero; repeated positions per market; frozen reporting rates; comparison eligibility and normalized chart only with complete evidence | Sample catalog (sample opening dates; one recorded close and resolution; no price history → value over time unavailable) | Bounded price history endpoints; demo capture with `executionAt`, trading window and resolution evidence | Replay engine on the shared ledger (Phase 8) | Replace `runReplay` with the replay service; keep the presentation |
| Notifications & search | Per workspace; origin labelled with the workspace name | Sample-derived | Sync runs, settlements | Account/market events (merged Phase 7 foundation; validation in Phase 9) | Actual events |

The frontend's calculations stay fixture, validation and presentation logic. Authoritative accounting, valuation, risk, scenario and replay results come from the backend.

### Reporting currency and exchange rates (frontend contract)

- **Preference:** Settings › General › *Reporting currency* (USD default; EUR and GBP. `REPORTING_CURRENCIES` in `lib/fx.ts`. A stored SGD or MYR preference falls back to USD in `readSettings`; `currencyInfo` and `fmtReporting` still format SGD and MYR so backend amounts are never dropped). It is presentation and analysis only: `ReportingProvider` (`lib/reporting.tsx`) sets how `fmt` / `sfmt` / `kfmt` / `HeroFigure` show portfolio money; `fmtNative`, prices, quantities, payout units, execution prices and native funding are never converted, and no stored amount changes.
- **Contract (`FxReference`):** base/quote, rate (null when unavailable — never defaulted to 1), kind (`fiat`, `stablecoin`, `hypothetical`), source, methodology, observation and retrieval times, freshness (current, recently refreshed, last-known, stale, unavailable, unsupported, override), evidence revision. `FxService.reference(base, quote)` is the frontend's view of the backend service; components never fetch rates.
- **Development fixture:** constant, labelled fixture references (USD→EUR 0.92, USD→GBP 0.79; USDC and PUSD fixture references of 1.0000 that are fixture values, not a claim of parity). Stale and missing rates are covered by tests that pass their own table to `fixtureFx(today, prefs, table)`. Never described as live; Data status shows an *Exchange rates* stream.
- **Methodology:** current tracking uses the latest eligible reference; historical performance needs the reference for each valuation date (backend). With the constant fixture, historical charts are a constant-rate view and labelled as fixture rates. Saved scenarios keep their results in the USD basis and are shown in the reporting currency at the current reference (a display conversion, not a re-evaluation). Historical Replay converts each native value at the rate for its own date (`RateAt`), using reference rates by default and explicit hypothetical overrides (advanced, saved with the replay).
- **Missing conversion:** values are shown in USD with the code (never as zero); native results remain.

### Independent Scenario Lab

- **Collection ownership:** scenarios (`scevia-scenarios-v5`, active `scevia-active-v5`) and replays (`scevia-replays-v2`) are the user's Scenario Lab collection, not a tracked portfolio's. Per-portfolio keys from the previous version are merged in once by key (never duplicated) and removed after a successful write; current-portfolio scenarios migrated that way are frozen at that portfolio's state.
- **Frozen starting portfolio:** a current-portfolio scenario stores a minimal snapshot (`pages/lab/baseline.ts` `freezeBaseline`) and its source (`{ workspaceId, name }`). It is evaluated only against that snapshot (`createFinance(frozen)` via a nested `FinanceProvider`), so refreshes, other portfolios, market revisions and the reporting currency don't change it (tested in `lib/baseline.test.ts`). When the source portfolio is selected and differs, *Review changes* previews differences (cash, holdings added/removed/resized, marks, date) with *Keep current start*, *Copy with latest portfolio* and *Update starting portfolio*. When it isn't selected or has no data, the frozen start and results are kept and the latest isn't compared. *Check latest* (reference prices only) is separate from rebasing.
- **Capability gating:** *Modify current portfolio*, the *Current portfolio* starting choice, baseline switching, examples and hand-offs need portfolio data; *Build from scratch* and *Historical replay* never do. Hand-offs into a current-portfolio scenario add holdings missing from its frozen start as new purchases.
- **Virtual funding:** current-market scenarios take virtual starting / additional capital per venue (shown with its native asset), with *Add … virtual capital* for a shortfall; replays use explicit buckets (venue + asset). Not yet unified: current-market scenarios still pool by venue — the backend's account/denomination buckets (`hypotheticalBuckets`) replace that at integration.
- **Market discovery:** `MarketCatalog` (search, provider link or native id via `resolveLink`, explicit statuses: invalid, unsupported provider, unsupported market type, not found, unavailable, temporarily unavailable, access unavailable, resolved) is provided by `MarketCatalogProvider` (`lib/marketContext.tsx`). Markets carry `denomination` and `evidence` (price, history, fee, resolution: available / partial / unavailable / loading); a found market can be unpriced. Both Scenario Lab's *Add markets* and the replay picker use it, with stale-response guards. The bundled catalog is the labelled sample; the development discovery fixture (`devDiscovery()`) adds markets not in it and deterministic slow / failing / unsupported cases. Research demand, latest-reference retrieval and expiry have a merged backend foundation (PR #9); historical evidence is Phase 8 and validation against real sources Phase 9.

### Final frontend contracts (this round)

- **Market and outcome identity:** a selection is `provider + marketId + outcome`; `CatalogOutcome.nativeId` / `InstrumentRef.nativeOutcomeId` / `ReplayMarket.nativeOutcomeIds` carry the provider's own outcome id when the market service supplies one (null for the fictional sample — never invented), and `CatalogMarket.identity` says whether ids are `fixture` (synthetic) or `provider`. **Adapter at integration:** backend market search/resolve rows → `CatalogEvent` / `CatalogMarket` (provider, native market id, title, status, trading window, verified resolution, `denomination`, evidence availability) and outcomes → `CatalogOutcome` with `nativeId` = the backend canonical outcome/instrument id; scenario and replay positions send `provider + marketId + nativeOutcomeId`.
- **Native settlement asset:** `CatalogMarket.denomination` / `ReplayMarket.denomination` is what the market service establishes; it is never derived from the venue (Polymarket has legacy USDC and current PUSD markets). Replay positions are funded only from a bucket with the same venue AND asset (`bucketFor`, created empty when missing); a market whose asset isn't established can't be added or funded. The fictional sample's rule (Polymarket → USDC, Kalshi → USD) applies only to sample markets and to replays saved before denominations were stored.
- **Discovery requests:** results are keyed by the request that produced them; only results for the current query (and provider / mode) are shown, older responses are dropped, and closing the dialog drops anything in flight. The replay picker has an explicit *Search | Link or id* mode, exact-outcome picks that persist across queries in a visible basket (count = positions added), and every resolution state (invalid, unsupported provider, unsupported market, not found, unavailable, temporarily / access unavailable).
- **Exchange-rate selection:** automatic. Settings › General shows *Exchange rates are selected automatically* and a collapsed *Rates in use* list (leg, rate, provider name from `SOURCE_LABEL`, date), with a warning when a leg is stale or missing. The source selectors were removed because each source covers only its own legs, so a choice was misleading. `FxPreferences` (`fiatSource`, `stablecoinSource`, mirroring `PUT /v1/preferences/reporting`) stays in the settings model and `fixtureFx` for a later capability-aware control: one that appears only when the backend reports more than one eligible source for a leg.
- **Kinds of money:** native amounts (`fmtNative`), authoritative reporting amounts already in the reporting currency (`fmtReporting`, never converted again) and fixture display conversion (`fmt` / `sfmt` / `kfmt` from the USD basis). Integration adapters wrap backend values as reporting or native; only fixture values use display conversion. A confirmed zero converts to zero without a rate; unknown stays unknown.
- **Frozen results and assumptions:** current-market scenarios evaluate on their frozen starting portfolio; replays convert with reference rates captured in the replay (`refRates`) plus explicit hypothetical overrides — newer references are taken only with *Use latest rates*. The Phase 8 backend freezes per-date historical evidence and authoritative results; the frontend will display those and keep the same explicit refresh / rebase actions.
- **Legacy migration:** a current-portfolio scenario from the earlier per-portfolio storage without a recorded starting portfolio keeps its configuration and source, shows *Original starting portfolio unavailable* with no results, and needs *Set a new starting portfolio*, which is marked as new (`baselineNote: 'replaced'`). It is never given another portfolio's or an empty state silently.
- **Current-market funding:** still one virtual cash pool per venue in this prototype, labelled as such; at integration each venue's inputs bind to the backend's native funding buckets (`hypotheticalBuckets`: venue/account + asset), and different assets never fund each other.

### Backend dependencies (remaining)

| Need | Backend owner | Frontend seam |
|---|---|---|
| Exchange-rate references (current, per date, per evaluation) with provenance and revision | Merged (PR #9: ECB, Kraken, CoinGecko adapters, `PUT /v1/preferences/reporting`); authorized sources in Phase 9 | `FxService`, `ReportingProvider`, `RateAt` |
| Market discovery by title, link and native id; evidence availability; research demand and latest references | Merged foundation (PR #9); historical evidence Phase 8; real-source validation Phase 9 | `MarketCatalog` via `MarketCatalogProvider` |
| Frozen baselines, revisioned saves, rebase preview/confirm, account/denomination funding buckets | Merged Phase 5/6 contracts | `freezeBaseline`, `baselineDiff`, Scenario fields `frozen` / `source` |
| Scenario and replay persistence per user | Phase 10 (bind to backend collections); identity Phase 11 | collection keys (`scevia-scenarios-v5`, `scevia-replays-v2`) |
| Historical Replay engine (chronology, evidence, ledger, FX per date, frozen results) | Phase 8 (in development) | `runReplay` result shape, `refRates` |
| Authorized real data: provider access, sources, account and Demo validation, operations and cost | Phase 9 | — |

### Public Beta requirements (Phase 11, not frontend work here)

Production identity and authorization, isolation, retention, export and deletion, source revocation, operational readiness and external testing gates must be in place before private financial workspaces are exposed. The Sample portfolio stays development-only; the user-facing Demo uses authorized market evidence, virtual capital and backend results.

## Adding sources (CSV, providers)

- **Normalize every source into the same canonical records.** CSV imports and provider adapters produce:
  - positions;
  - fills with direction;
  - cash movements;
  - settlements;
  - balances;
  - coverage.

  The frontend loader maps those records into `PortfolioData`. Sources stay provider-neutral (`provider` + native ids), so adding Predict.fun or another market doesn't change the UI contracts.
- **Generalize `Platform`.** Replace the `'pm' | 'ks'` union with a provider id plus display metadata during the real-data loader change. `PlatformBadge` already takes the mark from one place.
- **Keep the contract gaps from PR #3.** Resolve these in the loader change, not in pages:
  - decimal strings;
  - three fee states (reported, estimated, unavailable);
  - nullable marks;
  - sells and partial exits;
  - UTC timestamps;
  - transfers and adjustments.

## Real-data integration plan

Order of work, following the roadmap (Issue #2), each step verified against real data before the next:

1. **Backend foundation (Phase 1, PR #3).** Canonical provider-neutral records, coverage and scoped read APIs.
   - Privacy, source ownership and isolation are designed here, not deferred.
2. **Polymarket public wallet + initial public market lookup (Phase 2).** Then add an async `PortfolioData` loader (context with loading, empty, partial and error states) that replaces the module constants.
   - Keep `SAMPLE_PORTFOLIO` as the test fixture and as an optional sample mode.
3. **Reconciliation + CSV import (Phase 3).**
   - CSV works for any provider and alongside connections.
   - Fees take three states (reported, estimated, unavailable).
4. **Real-data analytics and event risk (Phase 4).**
   - Replace the binary-only assumptions where provider data needs it.
   - Introduce the bounded outcome engine.
5. **Scenario construction (Phase 5).** New markets and supported market links (extension path above).
6. **Kalshi read-only + cross-platform portfolios (Phase 6).** Reviewed event relationships; provider-native identity preserved.
7. **Real Data & Continuous Portfolio Tracking Foundation (Phase 7).** Merged (PR #9): acquisition, sync, revaluation and FX foundations; real-data and financial acceptance outstanding.
8. **Historical Replay Engine (Phase 8).** Replay on the shared ledger with recorded observations and trading windows.
9. **Real Data Acquisition & Validation (Phase 9).** Authorized provider access, source evaluation, real market / FX / account validation, real-market Demo, independent Scenario Lab and replay validation, measured operations and cost. The gate to integration.
10. **Unified Product Integration & Internal QA (Phase 10).** Bind the four modules, Scenario Lab and Historical Replay to validated backend read models; merge PR #1.
   - Reporting preference alignment: the backend `reportingCurrency` enum accepts USD, SGD, EUR, GBP and MYR; the frontend offers USD, EUR and GBP. At integration, either narrow the backend's accepted values for new writes or keep them and map an unsupported stored value to USD in the UI (as `readSettings` does). The backend schema isn't changed in PR #1.
   - Exchange-rate sources: keep automatic selection; expose a per-leg source choice only when the backend reports more than one eligible source for that leg.
   - Bind *Rates in use* to the backend's FX references (provider, observation time, freshness) instead of `fixtureFx`. The frontend shows `FxReference.sourceName` as given, so new providers (e.g. from Phase 9 source evaluation) need no UI change.
   - Partial valuation status: fixture amounts are already in a USD basis, so with a missing pUSD or USDC reference the frontend can warn (Settings, ReportingNote) but can't mark the portfolio total partial. The backend read model must flag totals that depend on a missing reference, and the UI must show them as partial or unavailable.
   - Development checks for this: `scevia-dev-fx` = `stale` | `missing` | `alt` (with the development workspaces) swaps in rate variants (`devFx()` in `data/devWorkspaces.ts`), and `node scripts/scan-copy.mjs <baseURL>` scans rendered copy across pages, dialogs and states for punctuation and spacing defects.
11. **Secure Release & Free Public Beta (Phase 11).**
   - Secure cloud workspace, export and deletion, then external testing.
   - Production identity, authorization and isolation must exist before any private cloud portfolio is exposed to real users.

### Integration considerations

- Every number must still satisfy the invariants tested in `finance.test.ts` (value − net deposits = net P&L; platforms sum to the total). Run those tests against real fixtures, not just the sample.
- **Partial data:** when a field is missing, show the figure as an estimate or unavailable (as with `feeKnown`). Never fill gaps silently.
- **Timezones:** the model uses UTC dates. Platform timestamps need a defined day boundary.
- **Marks:** decide which price is "mark" (last trade vs. mid) per platform and label it.
- **Privacy:**
  - Wallet addresses are public, but the user's *association* with one is private.
  - Don't log addresses.
  - Provide deletion and export before storing private records.
  - Product principles are in `PRODUCT.md` (Privacy and user control).

## Decision log

Design-system decisions: `design-system/DECISIONS.md`.

Product and engineering decisions from PR #1:

- **One ledger, pure calculations.** No page holds its own figures.
- **Scenario results are expressed as portfolio value** so purchases can't read as profit.
- **Best/worst cases come from feasible joint outcomes**, never post-hoc adjustment.
- **Funding shortfalls are explorable.** Invalid input is excluded; the two are treated differently.
- **No simulated onboarding.** Unavailable actions are disabled rather than faked.
