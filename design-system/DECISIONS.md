# Design-system decisions — evidence log

**Date:** 2026-11-24 · **Status:** proposal for review · **Supersedes:** the v1 "Quiet Ledger" light concept (removed). A later white v3 variant was also explored and removed; the product is dark-only.

This file records *why* the system is shaped the way it is. Agents do not need to load it for normal UI work.

## 1. What the reference products actually look like (studied live, Nov 24 2026)

| Reference | Observed | Taken into Scevia |
|---|---|---|
| **getquin** (desktop web app, shown on getquin.com) | Near-black canvas, dark-grey cards with hairline borders, white primary button ("Start now"), breadcrumb (Net worth › Investments), tabbed sub-views, a large balance with small decimals and currency (`90,880.82 €`), a green line chart with a scrubber, a blue allocation donut, and a period selector (1D 1W 1M YTD 1Y Max) | Dark canvas and stepped surfaces, white primary action, big-figure/small-decimal pattern, period selector on the chart, tabs inside cards |
| **Delta** (app screens on delta.app) | Black UI, very large "Total worth" with a signed delta, filter pills (Crypto/Stocks/Funds), a 2×2 grid of metric tiles with large coloured numbers, vivid donuts, PRO badges, a violet brand and a neon-green CTA | Pill filters, metric tiles, a violet accent kept for selection and Scenario Lab, vivid but tuned data colours |
| **Portfolio Visualizer** (backtest results) | Left rail of result sections (Summary, Exposures, Active Returns, Metrics, Annual/Monthly Returns, Drawdowns, Assets, Rolling Returns), "Highlights" tiles in Return/Risk groups, **a prose summary explaining the numbers**, portfolio-vs-benchmark tables, export (Link/PDF/Excel) | Left section rail with jump links, a written summary block, highlight tiles grouped by question, side-by-side comparison tables, export actions |

Conclusion: two of the three references are **dark-first, monochrome with one accent and vivid gain green**. The v1 light paper/serif concept did not match. v2 is dark, and the product is dark-only (the light theme was removed on 2026-11-24).

## 2. Tools evaluated

| Tool | What it is (verified from its own docs) | Fit for Scevia | Decision |
|---|---|---|---|
| **UI UX Pro Max** | Searchable local DB (styles, palettes, type pairings, chart rules, UX rules); `--design-system` generator; `--persist` writes `design-system/MASTER.md` + page overrides | High for *inputs*. Its first auto-pick (generic "SaaS mobile", electric blue) was wrong for us; the targeted query "fintech dark portfolio tracker" returned **Modern Dark: monochrome + accent, for fintech/trading dashboards**, and the **Fintech/Crypto palette (purple accent on dark)**. Its rules (tabular numbers, 4.5:1 contrast, colour-not-only, 150–300 ms motion) went into DESIGN.md and the lint. | **Primary source of design inputs.** Don't adopt its MASTER.md format: it re-states values that belong in tokens. |
| **Taste Skill** | Landing-page builder: deals palette, fonts and one of 11 hero layouts; "one section per screen"; real photos; browser finish-gate | Low. Built for marketing sites, not a data-dense app | Borrow one idea: **verify in a real browser before calling it done** (we render with headless Chrome). |
| **Hallmark** | Anti-"AI-generated" page skill: tiered rules (Floor never ships / Reflex / Finish), 50 themes, `sloplint` at 8 widths, fresh-context reviewer | Medium. Also landing-page-oriented, but its **Floor tiering** is a good enforcement model | Adopt the tiering in DESIGN.md ("Floor" rules = lint errors). Don't use its themes. |
| **Impeccable** | Design vocabulary + commands (`critique`, `audit`, `distill`, `clarify`, `polish`…), reads `PRODUCT.md` + `DESIGN.md`, 62-check detector, edit hook | High for **refinement and critique**, not for generating the system | Ship `PRODUCT.md` + `DESIGN.md` at the repo root in the shape it expects, so `/impeccable critique` / `distill` work later on demand. Not installed yet: your call. |
| **Astryx (Meta)** | Open-source React 19 + StyleX design system, 190+ components, CLI/MCP, Beta | Possible implementation base later | Deferred to the implementation phase. Our tokens are DTCG JSON, so they can be mapped into StyleX themes or Tailwind if we pick it. |
| **Awesome-Design-Tools** | Curated directory | Discovery only | No action. |
| **Gemini as critic** | Your workflow: Gemini critiques, Claude/Codex implements | Complementary | `design-concepts/v2/renders/` are ready to hand to Gemini. Critique prompts can cite DESIGN.md's Do/Don't list. |

## 3. File architecture: why not just DESIGN.md

Your four objections to a single DESIGN.md hold up, and each gets a mechanical answer:

| Problem with DESIGN.md alone | Answer in this repo |
|---|---|
| No component inventory → agents reinvent UI | `design-system/components.md`: 3 lines per component (what / use / don't) + required states |
| No enforcement | `design-system/lint/design-lint.mjs`: **fails** on raw hex/rgb/named colours, raw font sizes/families, unknown tokens; warns on off-scale spacing. `--contrast` fails on WCAG AA violations. `build.mjs --check` fails if tokens.css drifts from tokens.json |
| Missing states and interactions | `components.md` lists required states per component; DESIGN.md has motion + state rules |
| Context bloat | `AGENTS.md` is ~15 lines and always loaded. Everything else is **pointed to** and loaded only when touching UI. DESIGN.md never repeats token values |

Final layout:

```text
AGENTS.md                 ← always loaded, hard rules only (CLAUDE.md imports it)
PRODUCT.md                ← who / why / tone (impeccable-compatible)
DESIGN.md                 ← lean visual intent + Do/Don't + Floor rules
design-system/
  tokens/tokens.json      ← single source of truth (W3C DTCG)
  tokens/tokens.css       ← generated; the only place raw values appear
  tokens/build.mjs        ← json → css, with --check
  components.md           ← inventory + states
  lint/design-lint.mjs    ← enforcement (+ --contrast)
  DECISIONS.md            ← this file (not loaded by default)
design-concepts/v2/       ← the four screens, built only from the above, lint-clean
```

## 4. Things this round did not do

- Didn't accept Portfolio Visualizer's user agreement, so I studied its page text and the layout visible behind the dialog. I didn't use any interactive results.
- Didn't install Impeccable, Hallmark, or Taste skills (installing adds hooks/plugins to your environment). Recommended next step: `npx impeccable install`, then `/impeccable critique` on the v2 renders.
- No Gemini critique pass: the renders are ready for you to run one.
