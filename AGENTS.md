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
