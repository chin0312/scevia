# Development notes

Internal state of the codebase: what exists, what doesn't, known limitations, and how real data will plug in. The public introduction is `README.md`; calculation rules are in `docs/METHODOLOGY.md`.

_Last updated: 2026-11-25_

## Current state

- **Frontend:** all four modules are built (Overview, Analytics, Risk, Scenario Lab). It is a dark-only design system enforced by lint.
- **Data:** a deterministic **sample portfolio** (`web/src/data/sample.ts`) used as both fixture and exploration mode. There is no backend, no auth and no account connections.
- **Calculations:** one pure module (`web/src/lib/finance.ts`) with 50+ unit tests. Scenario bookkeeping is in `web/src/lib/scenarios.ts`.
- **Persistence:** scenarios, the guardrail, the fee setting and the BTC × ETH relationship choice are kept in `sessionStorage` (one browser tab) through `lib/storage.ts`.
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
  - sample data only; the Data sources panel shows account connections as unavailable (buttons are disabled, not simulated);
  - intermediate historical marks are synthetic paths between real anchors (first fill → previous visit → today);
  - drawdown and the value chart use weekly snapshots;
  - closed-trade fees are recognised at close; trades can't be partially closed in the history model (a closed trade is one round trip).
- **Fees:** the rates in `feeRates` are fictional. Real Kalshi fees are not a flat percentage.
- **Scenarios:**
  - no slippage or order-book depth;
  - the assumed fill price is applied to the whole size.
- **Relationships:** only the BTC × ETH relationship is user-classifiable; others are fixed in the data or unclassified. Equivalent contracts are modelled by sharing an `eventId`.
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
- `relationsFor()` special-cases the BTC × ETH pair. Replace it with user overrides keyed by event pair once relationships come from data.
- Event grouping relies on `eventId` provided by the data. Cross-platform matching rules don't exist yet.
- Some pages compute a lot in render (`series()` per filter). It's fast for the sample; profile it with real history sizes.

## Data boundaries to keep

These are separate concepts today and must stay separate when persisted:
- **Portfolio records.** Source data, read through `data/portfolio.ts`. The backend owns ingestion; see `backend/docs/FRONTEND_INTEGRATION.md` in PR #3.
- **Analytical assumptions.** Relationships, guardrail, fee setting (`lib/storage.ts`).
- **Scenarios.** `lib/scenarios.ts`, pure; hypothetical only.
- **Source configuration.** Which sources a user selected; not built yet.

A future authorized workspace persists the last three per user. Portfolio records stay owned by sources and imports.

## Scenario Lab: what exists, what Phase 2/5 replace

**Built (Phase 0):**
- current-portfolio and empty-portfolio starting points;
- per-platform added capital;
- per-scenario fees and relationship override;
- held and new instruments (`Adjustment.instrument`);
- the Add position dialog (holdings / search / paste link);
- allocation impact;
- comparison against each scenario's own start;
- migration from older stored scenarios (`scevia-scenarios-v3` → `-v4`).

**Data boundary:**
- `MarketCatalog` (`lib/markets.ts`), with `search(query, {provider})` and `resolveLink(url)` returning a `LinkResolution`.
- `data/markets.ts` picks the implementation; today `fixtureCatalog(SAMPLE_MARKET_EVENTS)`.
- The UI never imports the fixture directly and never fetches a pasted URL. `parseMarketLink` only recognises supported hosts.

**Frontend expectations for Phase 2 (market lookup + link resolution).** These are not a finalized API; verify against Polymarket's documentation and responses first.

| Need | Expectation |
|---|---|
| Search | Server-side search over public market metadata. Optional provider filter. Paginated. Returns events with markets and outcomes. |
| Link resolution | A backend endpoint takes the pasted URL and returns `resolved` / `not-found` / `unsupported` / `unavailable` (same states as `LinkResolution`). The browser sends the URL only to Scevia's backend. |
| Identity | Provider-native `externalEventId`, `externalMarketId`, outcome `externalId` (backend `NormalizedMarket`). The frontend's `marketId` / `outcome` map to these. |
| Prices | Reference price per outcome as a **decimal string**, with `observedAt` (UTC) and `priceKind`. It may be null; the UI then requires a typed price and shows value as unavailable. |
| Lifecycle | Market and event lifecycle (open / closed / resolved) and resolution rules or settlement terms. Closed or resolved markets can't be added. |
| Outcomes | Binary YES/NO today. The response should list all outcomes, so multi-outcome markets can be shown and, later, modelled. |
| Fees | The provider's fee schedule or an explicit "estimated / unavailable" status, not a flat sample rate. |
| Settlement groups | Which contracts settle together comes from **reviewed** relationships, never title matching. |

**Phase 5 (real-data scenario construction):**
- load the user's portfolio asynchronously as the "current portfolio" start;
- persist scenarios per user (workspace), including instrument refs and the reference price/time used;
- replace fixed `pm`/`ks` with provider ids;
- use real fees;
- replace the 16-event cap with a bounded exact method.

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
7. **Release readiness (Phase 7).**
   - Secure cloud workspace, export and deletion, then user testing.
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
