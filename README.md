<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design-system/brand/scevia-logo-on-dark.png" />
    <img src="design-system/brand/scevia-logo-on-light.png" alt="Scevia" width="280" />
  </picture>
</p>

<p align="center"><b>Prediction Market Portfolio Intelligence</b><br/>Track your positions · Understand your performance · Explore what-if scenarios</p>

---

## What is Scevia?

Prediction-market traders often hold positions across Polymarket and Kalshi, but platform dashboards answer only part of what they need to know. Questions like these are hard to answer with them:

- How much did I actually make after fees?
- Which kinds of trades drive my results?
- Which event could hurt me most?
- What would happen if I resized a position?

Scevia is a **read-only** workspace that brings those answers together. It never places trades or holds funds.

> **Status: early prototype for user testing.** Everything runs in the browser on a **fictional, deterministic sample portfolio**. There is no backend, no real account connection and no trading. Numbers are internally consistent and tested, but this is not financial software and nothing here is investment advice.

## The four modules

| Module | Question it answers | What's implemented |
|---|---|---|
| **Overview** | What do I own, and what changed? | Portfolio value vs. net deposits over time, P&L tiles, holdings with drill-down to fills, allocation, upcoming resolutions, and data coverage with staleness and fee-estimate flags. Platform filter (all / Polymarket / Kalshi) scopes every number. |
| **Analytics** | Where do my results come from? | Period and platform filters, net P&L reconciled into realized vs. open positions, attribution by category or platform, computed insights (hidden when the sample is too small), entry price vs. outcome, and a comparison with the prior period when the history covers it. |
| **Risk** | What am I exposed to? | Event-level concentration (the same outcome on two platforms counts once), an editable guardrail, a downside ladder, settlement payoffs, best/worst cases over **feasible** joint outcomes, event relationships, and a resolution calendar. |
| **Scenario Lab** | What if I change something? | Resize positions at hypothetical prices with per-platform cash checks and optional fees, see before/after portfolio value and settlement range, an outcome matrix for any two events, and a live comparison of saved scenarios. |

## How the numbers work

All figures come from one sample ledger (`web/src/data/sample.ts`): cash flows, fills of open positions, closed trades, and current marks. One pure calculation module (`web/src/lib/finance.ts`) derives everything from it, so pages can't disagree.

- **Net P&L** = realized P&L (after each closed trade's fees) + unrealized P&L − fees on open fills. Every fee is counted once.
- **Portfolio value** = cash + positions at mark, and **portfolio value − net deposits = net P&L**. Deposits and withdrawals are never treated as performance.
- **Settlement payoffs** are deterministic: $1 per share if your side wins, $0 otherwise. Scevia never assigns probabilities.
- **Event relationships** (equivalent / mutually exclusive / related / unknown) constrain which joint outcomes are possible. Best and worst cases are searched only over feasible combinations; unclassified pairs are flagged as unmodeled dependencies.
- **Scenarios** are expressed as portfolio value, so a hypothetical purchase moves cash into contracts and never shows up as profit.

The same definitions are available in the app under **Help → How Scevia calculates P&L**.

## Tech stack

- **App:** React 19, TypeScript, Vite, React Router. Charts are hand-written SVG, with no chart library.
- **Design system:** W3C DTCG design tokens → generated CSS custom properties, plus a custom design lint and a WCAG contrast check.
- **Tests:** Vitest for the calculation layer, Playwright for the main user journeys, and GitHub Actions on every PR.

## Repository structure

```text
web/                     the prototype app
  src/data/sample.ts     fictional sample ledger (single data source)
  src/lib/finance.ts     all calculations (accounts, history, periods, relationships, scenarios)
  src/lib/*.test.ts      unit tests
  src/pages/             Overview, Analytics, Risk, Scenario Lab
  src/components/        shell, overlays, charts, shared UI
  e2e/                   Playwright journeys
design-system/
  tokens/                tokens.json (source) → tokens.css (generated)
  lint/                  design lint + contrast check
  brand/                 logos, marks and icon generator
  components.md          component inventory and rules
  DECISIONS.md           why the system looks the way it does
design-concepts/v2/      the static concept the app was built from
DESIGN.md · PRODUCT.md · AGENTS.md   visual intent, product rules, contributor rules
```

## Getting started

Requires Node 20+ (CI uses Node 24).

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

## Checks

Run from `web/`:

```bash
npm run lint         # oxlint
npm run check:design # design lint, WCAG contrast, tokens in sync
npm test             # unit tests (Vitest)
npm run build        # typecheck + production build
npm run test:e2e     # browser journeys (Playwright; uses local Chrome, CI installs Chromium)
npm run check        # lint + design + unit tests + build
```

## Design system

The UI is dark-only, built around a near-black canvas, grey surfaces, one violet accent, and green/red reserved for signed money.

- Tokens live in `design-system/tokens/tokens.json`.
- `node design-system/tokens/build.mjs` regenerates `tokens.css`.
- Components may only use semantic tokens. The design lint fails on raw colours, font sizes, font families and unknown tokens.

See `DESIGN.md` for visual intent and `design-system/components.md` for the component inventory.

## Implemented vs. planned

| Implemented in this prototype | Planned / not built |
|---|---|
| Four modules on a consistent sample ledger | Real Polymarket wallet ingestion and Kalshi import |
| Platform and period filters across pages | Accounts, auth, persistence beyond the browser session |
| Feasible-outcome risk and scenario engine | Fee schedules from platforms (sample rates are used) |
| Demo of the data-source flow, clearly labelled | Slippage and order-book depth in scenarios |
| Unit tests, browser journeys, CI | Mobile layouts (desktop ≥ 1280 px today) |

Out of scope by design: trade execution, tax reporting, investment advice, and probability forecasts.
