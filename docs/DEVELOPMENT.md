# Development notes

Internal state of the codebase: what exists, what doesn't, known limitations, and how real data will plug in. The public introduction is `README.md`; calculation rules are in `docs/METHODOLOGY.md`.

_Last updated: 2026-11-25_

## Current state

- **Frontend:** all four modules are built (Overview, Analytics, Risk, Scenario Lab). It is a dark-only design system enforced by lint.
- **Data:** a deterministic **sample portfolio** (`web/src/data/sample.ts`) used as both fixture and exploration mode. There is no backend, no auth and no account connections.
- **Calculations:** one pure module (`web/src/lib/finance.ts`) with 50+ unit tests. Scenario bookkeeping is in `web/src/lib/scenarios.ts`.
- **Persistence:** scenarios, the guardrail and the BTC × ETH relationship choice are stored in `sessionStorage` (per browser tab).
- **Tests:**
  - Vitest (`npm test`), covering ledger identities, periods, attribution, relationships/feasibility, scenarios and scenario lifecycle;
  - Playwright (`npm run test:e2e`), covering 9 journeys;
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
- **Persistence:** none beyond the session. The guardrail is a single per-event limit.
- **Layout:** desktop only (≥ 1280 px). Mobile is not designed yet.
- **Lint:** remaining oxlint warnings are React Compiler advisories (fast-refresh boundaries; setState in effects for URL/input sync).

## Technical debt

- `lib/finance.ts` reads the portfolio as module-level constants (`data/portfolio.ts`). This is fine for a synchronous fixture, but real data will be async and per-user. Next step: pass `PortfolioData` explicitly (or via React context) and memoise derived values per portfolio.
- `relationsFor()` special-cases the BTC × ETH pair. Replace it with user overrides keyed by event pair once relationships come from data.
- Event grouping relies on `eventId` provided by the data. Cross-platform matching rules don't exist yet.
- Some pages compute a lot in render (`series()` per filter). It's fast for the sample; profile it with real history sizes.

## Real-data integration plan

Order of work, each step verified against real platform data before the next:

1. **Polymarket (public wallet, read-only).** Fetch positions, fills (trades), settlements and current marks for an address. Map them to `OpenPosition`, `ClosedTrade` and `CashFlow`; deposits and withdrawals come from on-chain transfers.
   - Verify the fill → average-cost path matches Polymarket's own P&L within rounding, and document the differences.
2. **Data loading architecture.** Replace module constants with an async `PortfolioData` provider (context + loading/error states). Keep `SAMPLE_PORTFOLIO` as the test fixture and as an optional "explore with sample data" mode.
3. **Kalshi (CSV import, then read-only API).**
   - Map orders/fills/settlements; set `feeKnown: false` where fees are missing.
   - Use Kalshi's real fee schedule instead of `feeRates`.
4. **Event mapping.** Create `eventId` across platforms with manual confirmation first (concept rule: similar titles ≠ same settlement).
5. **Persistence and accounts.** Store scenarios, guardrails and relationship choices server-side, then add auth. Never request trading permissions.
6. **Freshness.** Per-source `asOf`/`stale` from real sync times, and a visible sync action once one exists.

### Integration considerations

- Every number must still satisfy the invariants tested in `finance.test.ts` (value − net deposits = net P&L; platforms sum to the total). Run those tests against real fixtures, not just the sample.
- **Partial data:** when a field is missing, show the figure as an estimate or unavailable (as with `feeKnown`). Never fill gaps silently.
- **Timezones:** the model uses UTC dates. Platform timestamps need a defined day boundary.
- **Marks:** decide which price is "mark" (last trade vs. mid) per platform and label it.
- **Privacy:** wallet addresses are public identifiers. Don't log them, and provide deletion before storing anything.

## Decision log

Design-system decisions: `design-system/DECISIONS.md`.

Product and engineering decisions from PR #1:

- **One ledger, pure calculations.** No page holds its own figures.
- **Scenario results are expressed as portfolio value** so purchases can't read as profit.
- **Best/worst cases come from feasible joint outcomes**, never post-hoc adjustment.
- **Funding shortfalls are explorable.** Invalid input is excluded; the two are treated differently.
- **No simulated onboarding.** Unavailable actions are disabled rather than faked.
