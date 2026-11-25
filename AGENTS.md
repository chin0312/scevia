# AGENTS.md

Scevia: read-only prediction-market portfolio intelligence. Product rules and terminology: `PRODUCT.md`.
App: `web/` (Vite + React + TS). Run `npm run dev` in `web/`. Current state, limitations and integration plan: `docs/DEVELOPMENT.md` (read only when relevant).

## UI rules (hard)
1. Before any UI work, read `DESIGN.md`, then `design-system/components.md` for the components you'll touch.
2. Use only semantic tokens from `design-system/tokens/tokens.css`. Never write raw hex/rgb, font sizes, or font families.
3. Reuse a listed component before creating one. A new component must be added to `components.md` in the same change.
4. Every interactive element needs hover, focus-visible, disabled, and (for data) loading/empty/error states.
5. Never present an outcome probability as Scevia's forecast. Never add trade-execution controls.
6. To change a value, edit `tokens.json`, then run `node design-system/tokens/build.mjs`.

## Interaction invariants
- Inspecting (detail panels, search, notifications) never navigates or changes a scenario. Scenario hand-offs go through `handoffPath()` and the Lab's confirmation.
- Detail panels start in the scope they were opened from (`scope`), and wider views are explicit.
- Overlays use the shared layer stack in `overlays.tsx`. Don't add page-level Esc or scroll-lock handlers.
- Browser storage goes through `lib/storage.ts` (`scevia-` keys only).
- Hypothetical positions live only in scenarios (`simulate()` results). Never add them to `PortfolioData`, and never let them change Overview, Analytics or Risk.
- Market lookup goes through the `MarketCatalog` interface (`data/markets.ts`). Never fetch user-supplied URLs, and always label sample market data as such.
- A missing number (no price, no fee parameters, too many events, invalid input) is unavailable, not zero. Use `diff()` / `judge()` for changes.
- Relationships are settlement logic with provenance. Only `verified` (facts) and a scenario's own `hypothetical` constraints remove outcomes; Risk never sees hypothetical ones. Never add event-specific relationship controls.
- Hypothetical fees go through `estimateFee()` (lib/fees.ts) only. Never hard-code a provider-wide rate, and never recalculate historical fees.
- Scenario targets go through `targetShares()`: shares, $ amount and % of start are views of one position. Never convert silently when the view changes.
- Identity is account + instrument. Use `holdingsOfInstrument()`; never map an instrument to "the first" holding.
- The records workspace (`/accounts`, `lib/records.ts`) is a labelled sample: it never feeds `PortfolioData` or any portfolio figure, never reads user files, and never deletes source records.
- Actual accounting belongs to the backend replay. Don't build a second actual ledger in the frontend.

## Numbers
- Every figure comes from `web/src/lib/finance.ts`, which reads data only via `web/src/data/portfolio.ts`. Never hard-code a metric, summary sentence or insight in a page, and never import `data/sample.ts` directly.
- Changing a calculation means updating `docs/METHODOLOGY.md` and the tests in the same change.
- If a metric can't be computed honestly (small sample, no prior period), show it as unavailable.

## Copy
- No development-stage wording in the UI. Sample data is labelled "Sample portfolio". Unavailable actions are disabled or removed, never simulated (see `PRODUCT.md`).

## Before finishing UI work
- In `web/`: `npm run check` (lint, design checks, unit tests, build) and `npm run test:e2e` must pass.
- `node design-system/lint/design-lint.mjs <changed paths>` must report 0 errors.
- `node design-system/lint/design-lint.mjs --contrast` must pass if tokens changed.
- Render the page in a browser and look at it. Don't trust code alone.
