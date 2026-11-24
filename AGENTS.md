# AGENTS.md

Scevia: a read-only prediction-market portfolio intelligence app. Product context: `PRODUCT.md`.
Frontend prototype: `web/` (Vite + React + TS, mock data, no backend). Run `npm run dev` in `web/`. Visual reference: `design-concepts/v2/`.

## UI rules (hard)
1. Before any UI work, read `DESIGN.md`, then `design-system/components.md` for the components you'll touch.
2. Use only semantic tokens from `design-system/tokens/tokens.css`. Never write raw hex/rgb, font sizes, or font families.
3. Reuse a listed component before creating one. A new component must be added to `components.md` in the same change.
4. Every interactive element needs hover, focus-visible, disabled, and (for data) loading/empty/error states.
5. Never present an outcome probability as Scevia's forecast. Never add trade-execution controls.
6. To change a value, edit `tokens.json`, then run `node design-system/tokens/build.mjs`.

## Before finishing UI work
- `node design-system/lint/design-lint.mjs <changed paths>` must report 0 errors.
- `node design-system/lint/design-lint.mjs --contrast` must pass if tokens changed.
- Render the page in a browser and look at it. Don't trust code alone.
