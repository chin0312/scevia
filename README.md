<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design-system/brand/scevia-logo-on-dark.png" />
    <img src="design-system/brand/scevia-logo-on-light.png" alt="Scevia" width="280" />
  </picture>
</p>

# Scevia

**Prediction market portfolio intelligence.** Track your positions, understand your performance, and explore what-if scenarios across Polymarket and Kalshi.

> **Status: clickable prototype.** All data is fictional sample data. There is no backend, no account connection and no trading. Scevia is read-only by design.

## What's here

| Path | What it is |
|---|---|
| `web/` | Frontend prototype: Vite + React + TypeScript. Four areas: Overview, Analytics, Risk, Scenario Lab. |
| `design-system/` | Single source of truth for the UI: tokens (`tokens.json` → `tokens.css`), component inventory, design lint, brand assets, decision log. |
| `design-concepts/v2/` | The static design concept the app is built from (HTML + renders). |
| `DESIGN.md`, `PRODUCT.md`, `AGENTS.md` | Visual intent, product context, and hard rules for anyone (human or AI) changing the UI. |

## Run it

```bash
cd web
npm install
npm run dev
```

Then open http://localhost:5173.

## Checks

```bash
node design-system/lint/design-lint.mjs            # no raw colours, sizes or fonts; only known tokens
node design-system/lint/design-lint.mjs --contrast # WCAG AA on every semantic text pair
node design-system/tokens/build.mjs --check        # tokens.css matches tokens.json
cd web && npm run build                            # typecheck + production build
```

## Principles

- **Read-only.** Never places trades or holds funds.
- **Simulation ≠ forecast.** Scenario Lab shows payoffs *if* an event resolves one way or the other. It never presents a probability as Scevia's opinion.
- **Say what isn't covered.** Partial data, stale sources and unknown event relationships are always visible.
