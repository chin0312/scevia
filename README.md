<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design-system/brand/scevia-logo-on-dark.png" />
    <img src="design-system/brand/scevia-logo-on-light.png" alt="Scevia" width="280" />
  </picture>
</p>

<h3 align="center">Prediction Market Portfolio Intelligence</h3>
<p align="center">Track your positions. Understand your performance. Explore what-if scenarios.</p>

---

## Why Scevia

Active prediction-market traders often hold positions on Polymarket and Kalshi at the same time. Platform dashboards show balances and open contracts, but they leave the questions that matter most for the next decision hard to answer:

- What did I actually make after fees?
- Where do my results come from?
- Which single event could hurt me most?
- What would change if I resized a position?

Scevia brings those answers into one workspace. It is **read-only**: it never places trades, holds funds, or asks for keys that can trade.

## Modules

**Overview — what you own and what changed.**
Portfolio value against net deposits, realized and unrealized P&L, holdings with drill-down to individual fills, allocation that filters holdings by category or platform, upcoming resolutions, and data freshness.

**Analytics — where your results come from.**
Net P&L by period and platform, reconciled into realized results, changes in open positions, and fees. Attribution by category or platform, entry price vs. outcome, and descriptive patterns that are shown only when there are enough trades to describe.

**Risk — what you're exposed to.**
Exposure grouped by the event that decides the payoff, so the same outcome held on two platforms counts once. It also covers concentration against your own guardrail, a downside ladder, settlement payoffs, and best and worst cases over outcome combinations that can actually happen.

**Scenario Lab — what happens if you change something.**
Resize positions at the prices you assume you could trade at. Compare portfolio value and settlement range before and after, see two events' joint outcomes side by side, and compare saved scenarios. Funding gaps are flagged, and no orders are ever placed.

Every figure explains how it is calculated. Positions, events and the trades behind a figure open in a side panel on the page you're on; moving to another module or into a scenario is always an explicit step. Scevia shows payoffs if an event resolves one way or the other. It never presents a probability as its own forecast.

> Scevia currently runs on a bundled **sample portfolio**, labelled as such throughout the app.

## Tech stack

- **App:** React 19, TypeScript, Vite, React Router. Charts are hand-built SVG.
- **Calculations:** a single pure TypeScript module over a typed portfolio model.
- **Design system:** W3C DTCG design tokens compiled to CSS custom properties, enforced by a design lint and a WCAG contrast check.
- **Quality:** Vitest unit tests, Playwright end-to-end tests, and GitHub Actions CI.

## Repository

```text
web/                 the Scevia web app
  src/data/          portfolio model (types.ts), data entry point, bundled sample
  src/lib/           calculations (finance.ts), scenario state, formatting
  src/pages/         Overview, Analytics, Risk, Scenario Lab
  src/components/    app shell, overlays, charts, shared UI
  e2e/               end-to-end journeys
design-system/       tokens, component inventory, design lint, brand assets
docs/                development notes and calculation methodology
PRODUCT.md · DESIGN.md · AGENTS.md
```

## Getting started

Requires Node 20 or newer.

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

## Testing

From `web/`:

```bash
npm run check      # lint, design-system checks, unit tests, typecheck + build
npm run test:e2e   # end-to-end journeys (Playwright; uses a local Chrome)
```

CI runs both on every pull request.

## Contributing

Read [`AGENTS.md`](AGENTS.md) before changing the UI. It is short and lists the hard rules: semantic tokens only, reuse listed components, and keep every number coming from the calculation layer.

- Product principles and terminology: [`PRODUCT.md`](PRODUCT.md)
- Visual intent: [`DESIGN.md`](DESIGN.md)
- How figures are calculated: [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)
- Current state, limitations and integration plan: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
