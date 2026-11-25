# Product context — Scevia

**What:** Privacy-first, user-controlled, read-only portfolio intelligence for prediction markets. It never places trades, holds funds or takes custody. It is not a trading terminal, prediction engine, market-discovery site or advisory service. The full concept and validation plan are kept in an internal document outside this repo.

**Users:** Active, non-quant prediction-market traders (Polymarket, Kalshi and other markets over time). They understand prices as probabilities but don't run their own data stack. They're cautious about credentials, privacy and accuracy.

**Jobs:** Track (what do I hold, across the sources I chose?) · Understand (where did P&L come from?) · Diagnose (where could I lose most, event by event?) · Construct (what if I changed or added positions, and how do alternatives compare?).

**Differentiation:** reliable portfolio tracking + prediction-market-specific financial intelligence (settlement payoffs, event-level exposure, feasible outcomes) + interactive portfolio simulation. Privacy and user control are foundations, not features.

**The one thing to get right:** trust. A plain, correct number beats a beautiful wrong one. Every figure can explain its definition, source, and coverage.

**Tone of voice:** Calm, precise, plain English. Write `Loss if NO resolves`, not `Risk score 87`. No hype, no "AI-powered", no implied advice.

**Hard product rules (affect UI):**
- Simulation ≠ forecast. Never show the probability of an outcome as Scevia's opinion. Show payoffs *if* YES / *if* NO.
- Say what isn't covered: partial data, unknown event relationships, stale sync.
- "Portfolio" means the sources the user chose and that are sufficiently covered, not every market Scevia supports. A user may track one provider only, or imported files only. Say which sources a figure covers; never imply coverage of sources that aren't connected.
- No trade-execution affordances (no Buy/Sell buttons that look real).

**Accessibility:** WCAG 2.1 AA. Colour never carries meaning alone (YES/NO and gain/loss always have a sign, label, or icon). Fully keyboard operable. Respect reduced motion.

**Platform:** Desktop web first, with a fluid workspace: it keeps using width up to ultrawide (2560px), and running text keeps a readable line length. Tablet and phone widths must stay fully usable (no clipped content or sideways scrolling); a dedicated mobile design comes later, with Overview and single-event What-if first.

## Scope

- **In scope:**
  - tracking positions and value across user-selected sources;
  - performance review;
  - event-level risk;
  - hypothetical portfolio construction and comparison.

  All of it is read-only.
- **Out of scope:**
  - trade execution, copy trading, custody or access to funds;
  - signals or advice, probability forecasts;
  - tax reporting;
  - a separate market-browsing module.

## Data sources (user-selected)

Users choose how they provide data. No source is required, and each one can be added or removed independently.
- **Polymarket — public wallet address.**
  - Tracking is read-only.
  - An optional wallet connection may be used only to retrieve the address or verify ownership where appropriate.
  - A public address is a tracking identifier, not proof of ownership.
  - Never request private keys, seed phrases or transaction permissions.
- **Kalshi — authenticated, read-only account access**, with explicit consent and least-privilege permissions. The provider's actual mechanisms and terms are verified during integration.
- **File import (CSV) — a first-class source, not a fallback.** It covers:
  - historical records;
  - manually maintained records;
  - providers without direct support;
  - filling gaps in provider history.
- **Other prediction markets** (e.g. Predict.fun) join through the same provider-neutral contracts. Don't hard-code Polymarket and Kalshi as the only possible platforms in new contracts.
- **Sample portfolio:**
  - an optional exploration mode;
  - always labelled "Sample portfolio".

## Privacy and user control

The long-term product is a privacy-first **cloud workspace**: continuity across devices for sources, imported records, saved scenarios and preferences, without collecting more than needed.

**Principles:**
- explicit connections;
- read-only, least-privilege access;
- data minimization;
- account isolation;
- transparent sync and freshness;
- user-controlled disconnection, export and deletion;
- no sale of financial data, no advertising profiles, no AI training on private records;
- no trading, custody or access to funds.

**Keep these apart:**
- public market metadata;
- public wallet information;
- the user's private association with a wallet or account;
- private portfolio records;
- uploaded files and the transactions normalized from them;
- saved scenarios and analytical preferences;
- authentication and provider credentials.

**Identity and recovery:**
- A user's Scevia identity is separate from their provider identities.
- Re-entering a public address rebuilds only currently public data. It never grants access to someone else's workspace.
- Reconnecting a provider doesn't restore imported files, saved scenarios, or history the provider no longer exposes.

**Honest communication:**
- In-product privacy text describes what the build does today.
- Don't claim encryption, export, deletion or cloud controls before they exist.
- Future policies and the data lifecycle live in internal docs.

## Scenario Lab

Scenario Lab is a **portfolio construction and simulation workspace**. It follows the workflow below, without forcing a wizard: users move freely between inputs and results.
1. Choose or create a scenario.
2. Set it up: the starting portfolio (current or empty), optional added capital, fee treatment, and (optionally) hypothetical settlement constraints.
3. Build the hypothetical portfolio.
4. Review the impact: before/after, allocation, settlement outcomes.
5. Compare scenarios.

- **A new workspace is neutral.**
  - No scenarios and no pre-filled trades.
  - Unknown relationships stay unknown, and no added capital is assumed.
  - Examples exist, but only when the user picks one.
- **Positions come from three places:**
  - the user's holdings;
  - a market search;
  - a pasted link to a supported market.

  Lookup serves construction; it is not a browsing module. Links are resolved by the backend through trusted provider endpoints, never by fetching the URL in the browser. When a link covers several markets or outcomes, the user picks one.
- **Hypothetical vs. actual.**
  - Hypothetical positions never enter actual holdings, history or the other modules' figures.
  - A scenario stores, per position:
    - instrument identity;
    - quantity;
    - assumed price;
    - reference price and its timestamp.
  - It also stores its funding and assumptions.
- **Useful without an account.** An empty-portfolio scenario needs no connected source.
- **Current build:**
  - Market search and link resolution run against a small **sample market catalog**, labelled "Sample market data".
  - Real lookup arrives with provider integration (Phase 2), and real-data scenarios with Phase 5.

## Interaction principles

- **Four independent modules.** Overview, Analytics, Risk and Scenario Lab each answer their own question and are complete on their own. They share one data layer, not each other's screens.
- **Inspect, explore, navigate.** *Inspect* opens a detail panel (position, event, group of holdings, trades) on top of the current page. *Explore* changes a local view (grouping, period, a selected allocation segment) without changing portfolio-wide figures. *Navigate* moves to another module and is always an explicit, labelled action (“Analyze in Risk →”, “Simulate in Scenario Lab”).
- **No navigation just to see data.** Anything shown in one module that is defined in another (an event's exposure, a position's fills) is inspectable in place.
- **Scenario state only changes on purpose.** Nothing outside Scenario Lab edits a scenario. Hand-offs ask which scenario and which holdings to add; new positions start at the current holding and mark; Cancel changes nothing; reloading never repeats a hand-off.
- **One copy of every assumption.** Shared assumptions (the guardrail) are editable wherever they are used.
- **Facts vs. hypotheses.**
  - Verified relationships and market fee parameters are source facts. Risk only ever uses facts.
  - A scenario may add hypothetical constraints and its own fee treatment. These never change Risk or other scenarios, and an unsupported assumption never removes a possible loss from a factual view.
  - Relationships are settlement logic (which joint outcomes can happen), never statistical correlation.
- **Missing isn't zero.** Unavailable prices, fees or ranges are labelled as unavailable, never shown as $0.
- **Drill-downs keep scope.** A panel opened from a filtered view starts in that view's period and platform scope. It says so, and it offers the wider (e.g. all-platform) view explicitly. A metric never silently changes meaning between an aggregate and its details.
- **Hand-offs carry exact holdings.** "Simulate in Scenario Lab" sends the specific positions in the current scope, plus a note of where they came from. The Lab shows platforms and lets the user confirm.

## Terminology (use these words in the UI)

| Term | Meaning |
|---|---|
| Mark | Last traded price on the platform. |
| Cost basis / capital committed | What an open position cost (shares × fill price), excluding fees. |
| Realized / unrealized P&L | From closed trades after their fees / from open positions at mark, before fees. |
| Net P&L | Realized + unrealized − fees on open fills. Never includes deposits. |
| Settlement payoff | $1 per share if your side wins, $0 otherwise. |
| Feasible outcome | A combination of event results that can actually happen given verified relationships (and, inside a scenario, its hypothetical constraints). Not a probability. |
| Settlement constraint | A logical rule between events: equivalent (resolve the same way) or mutually exclusive (not both YES). Related and unknown impose none. |
| Provider fee estimate | A fee for a hypothetical trade from the market's published parameters and an assumed maker/taker role. Not a fee charged. |
| Assumed fill price | The price a scenario assumes a trade executes at. Not a quote. |
| Funding shortfall | Extra cash a scenario needs beyond the platform's balance. |

Full definitions: `docs/METHODOLOGY.md`.

## Product copy

- Write for the user of a real product. No development-stage words in the UI ("prototype", "demo", "coming soon", "planned").
- Sample data is always identifiable as **Sample portfolio**. Never claim an account was connected, imported, synced or verified when it wasn't.
- Unavailable actions are removed or disabled with a short reason. They are never simulated.
- Put assumptions and limitations next to the figure they qualify, not in page-wide disclaimers.
