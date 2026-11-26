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

Scenario Lab is a **portfolio construction and simulation workspace**. The user should know what to do before needing any formula; methodology stays one click away.
- **Entry.** Two starting paths, each with a short description and one action: *Modify current portfolio* (shows what is inherited: value, cash, positions, accounts) and *Build from scratch* (optional starting capital per venue; nothing inherited). Saved scenarios are listed to resume; examples are optional. Nothing is created and no chart is drawn until the user picks something.
- **Active scenario: Build · Analyze · Compare.** Three views of the same scenario state, not a wizard. A one-line summary of the scenario's assumptions sits above them with *Edit assumptions*.
  - **Build:** essentials first (starting portfolio, capital), then positions, with a live cash & value summary beside them on wide screens.
  - **Analyze:** a short summary (value at marks and feasible settlement range first), then charts that each answer one question, then exact tables. Anything in the analysis links back to the row that causes it.
  - **Compare:** the user picks which scenarios to compare; each is measured against its own start.
- **Progressive disclosure.** Fees, the assumed order role, hypothetical constraints and the methodology live in the assumptions drawer. Limitations appear where they change a number (an unavailable fee on its row and in the fee total), not as repeated paragraphs.
- **Construction.** Positions can be sized in shares, as a $ amount at the assumed price, or as a % of the scenario's starting value; these are views of one position, and switching never changes it. Markets are added several at a time, one explicit outcome each. Bulk actions keep their meaning: *Remove from scenario* restores the holding; *Set target to 0* simulates an exit.

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
- **Honest charts.** No equity curves, annualized returns, Sharpe ratios, drawdowns or Monte Carlo for hypothetical scenarios, and no expected values without stated probabilities. A settlement range is not a distribution.
- **Current build:**
  - Market search and link resolution run against a small **sample market catalog**, labelled "Sample market data".
  - Backend market lookup and scenario services are merged (Phases 2, 5–7); they are validated against real sources in Phase 9 and connected to this UI in Phase 10.

## Accounts, sources and records

A portfolio is **user-controlled** and can combine several accounts and acquisition sources.
- **Venue** (Polymarket, Kalshi) is where positions are held. **Account** is one wallet or login there; several accounts can share a venue. **Source** is how records arrive (API sync, CSV import, manual entry). CSV is a source, not a venue.
- Connection status is not accounting completeness: an account shows whether its opening balance and history are declared.
- Users manage their records: include, exclude, restore, correct imported or manual rows, resolve potential duplicates, accept distinct identical trades, and add manual records. Bulk actions show their scope (selected, page, all matching), preview their effect and are reversible. Excluding never deletes source data.
- A CSV import names its account and whether it supplements that account's history or stands alone. Overlaps are offered for review, never merged automatically; unmatched rows can be accepted in one decision.
- In this build these flows run in the Portfolio workspace (`/portfolio/transactions`, `/portfolio/imports`) on a clearly labelled **record-management sample** that never changes portfolio figures. Real imports and decisions need the backend accounting API.

## The workspace around the four modules

Six utilities, one job each (no item appears in two of them):

| Utility | Answers | Contains |
|---|---|---|
| Search (⌘K / Ctrl K) | Where is it? | Pages, portfolio sections, accounts, positions, events, records, scenarios, help topics and real actions (import, add record, review, create a scenario). Not market search (Add markets in Scenario Lab) and not record filtering (Transactions). |
| Portfolio | What am I analyzing, and what is it made of? | The active portfolio (one in this build: no fake switcher), its accounts and freshness, and the Portfolio workspace: Accounts · Sources · Transactions · Imports & reconciliation · Data coverage. |
| Help | How does Scevia work? | Getting started, user guide, methodology & glossary (what is calculated now vs. with connected accounts), keyboard shortcuts, feedback (GitHub Issues), about. |
| Notifications | What happened? | Upcoming resolutions (per event), concentration, position value moves, settlements, data quality, stale sources, imports. Stable ids, per-item read state, All / Unread and category filters. Shown while Scevia is open; no email or push. |
| Settings | How should the workspace behave? | General (default scope), Analytics (default period and grouping), Risk (guardrail), Scenario Lab (how targets are shown), Notifications. Each section restores its own defaults; *Reset all* asks first and never touches scenarios or records. |
| Account | Who am I, and what data is kept? | Guest state (sign-in not available yet) and Data & privacy: what this tab keeps, cleared by group (preferences, scenarios, sample records, notification state) or all at once, each confirmed. |

**Personal account vs. financial account.** Your Scevia account is your identity and data control. A financial account is a wallet or venue login inside a portfolio. They never share a menu.

**Settings change real behavior only.** Analytical filters on a page (scope, period, grouping) are views and never change the portfolio. Global defaults never rewrite a saved scenario's assumptions.

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
| Cost basis / capital committed | What an open position cost: shares × fill price + purchase fees (weighted average). |
| Realized / unrealized P&L | From closed trades after their fees / from open positions at mark vs. cost basis (after purchase fees). |
| Net P&L | Realized + unrealized. Never includes deposits. |
| Account / venue / source | One wallet or login / where positions are held / how records arrive (API, CSV, manual). |
| Value at reference marks | Cash + positions × reference price in a scenario. Not a quote and not a forecast. |
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
- **Human-first language.** Short, plain sentences. No middle-dot separator chains, em-dash separators or semicolons in UI text; use commas, parentheses or a new sentence. No statistical notation (`n = 24` becomes "24 trades, limited sample size"). Prefer everyday words: *Update starting portfolio* (not "rebase"), *Entry price*, *Exit price*, *Starting capital*, *Estimated fees*, *Historical price*, *Portfolio value*, *Total return*, *Drawdown*, *Hold to settlement*, *Virtual funds*.
- **Three layers of information.** (1) The answer: the figure or result with a short label. (2) What qualifies it: one line next to the figure (as-of date, partial, estimated). (3) Method and provenance: collapsed details, an info tip or Help. Status words such as *sample*, *hypothetical* or *kept in this tab* appear once where they matter, not on every card. Material warnings (unfunded, partial, unavailable, stale or missing rates, hindsight in Historical Replay) stay next to the result they affect.
- **Necessity first.** A sentence stays on a working page only if it says something the interface doesn't, explains a genuinely complex concept, states the consequence of an action, flags a limitation of the current result, or is needed to finish the task. Otherwise it is removed, not rewritten. Empty space is better than a redundant subtitle.
- **Where things live.** Dashboards: figures, charts, holdings, controls and the issues that affect them (`DataIssues`). Contextual help: `InfoTip` definitions from `lib/help.ts`. Provenance (sources, observation times, rates, coverage): Data status, Data coverage and Settings › Rates in use. Methodology: Help › Methodology by concept, and `docs/METHODOLOGY.md`. Product statements (read-only, no trading, no custody, not advice): Help › About and the privacy dialog, once, not in page footers.
- **Mode identification.** The portfolio chip and Data status identify Sample and Demo portfolios from the workspace mode, not the name. Scenario Lab and Historical Replay show the market-data mode (`MarketDataLabel`) separately from the selected portfolio.
- **Page titles:** Portfolio overview, Portfolio performance, Portfolio risk, Scenario Lab and Historical Replay. A saved scenario or replay is titled by its own name. No question-style or conversational headings, and no eyebrow label that repeats the title.
- **Text from data:** counts, lists and optional details are built with `lib/text.ts` (`count`, `joinList`, `sentences`, `phrase`), so zero, one or many items, missing fields and long names never produce wrong plurals, leading commas, doubled spaces or empty parentheses. Disclosures follow the actual data mode (workspace mode, `MarketCatalog.live`, `FxService.live`), never a hard-coded “sample”. Several limitations are shown as separate labels, not one comma chain.
- **Concentration limit** is the one name for the single-event share setting (Settings, Risk, notifications).
- **Historical Replay** explains itself once at the start of the workflow (what it is, that markets are chosen with hindsight and that entered prices may not have been available). It isn't repeated on every card.

## Reporting currency and native assets

- **Reporting currencies:** USD (default), EUR and GBP. These are the only selectable choices for now; a saved SGD or MYR preference from earlier versions moves to USD. Formatting still supports other ISO currencies the backend may report (it keeps SGD and MYR), so authoritative amounts are never dropped.
- **Native assets are instrument-specific and kept distinct:** USD (Kalshi), USDC (legacy Polymarket) and pUSD (current Polymarket, stored as `PUSD`). They are never merged or treated as each other. Balances, prices, payouts and replay funding stay in their native asset; only combined portfolio figures are converted.
- **Exchange rates are automatic by default.** Scevia chooses an eligible reference for each conversion (ECB for fiat, Kraken for USDC, CoinGecko for pUSD). Settings shows the rates in use in a collapsed *Rates in use* list with readable provider names and dates, and warns when a rate is out of date or missing. There are no source selectors in the UI.
- **Capability-aware advanced selection (later):** a user-chosen source will appear only when the backend reports more than one eligible source for a leg, and only for that leg. It is not shown otherwise.
