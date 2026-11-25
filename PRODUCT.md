# Product context — Scevia

**What:** Prediction-market portfolio intelligence. Read-only: it never places trades or holds funds. The full concept and validation plan are kept in an internal document outside this repo.

**Users:** Active, non-quant traders on Polymarket and/or Kalshi. They understand prices as probabilities but don't run their own data stack. They're cautious about API keys and accuracy.

**Jobs:** Track (what do I hold?) · Understand (where did P&L come from?) · Diagnose (where could I lose most?) · Explore (what if I resize a position?).

**The one thing to get right:** trust. A plain, correct number beats a beautiful wrong one. Every figure can explain its definition, source, and coverage.

**Tone of voice:** Calm, precise, plain English. Write `Loss if NO resolves`, not `Risk score 87`. No hype, no "AI-powered", no implied advice.

**Hard product rules (affect UI):**
- Simulation ≠ forecast. Never show the probability of an outcome as Scevia's opinion. Show payoffs *if* YES / *if* NO.
- Say what isn't covered: partial data, unknown event relationships, stale sync.
- Only label a view "entire portfolio" when every platform is connected.
- No trade-execution affordances (no Buy/Sell buttons that look real).

**Accessibility:** WCAG 2.1 AA. Colour never carries meaning alone (YES/NO and gain/loss always have a sign, label, or icon). Fully keyboard operable. Respect reduced motion.

**Platform:** Desktop web first (1280–1600). Mobile later, with Overview and single-event What-if first.

## Scope

- **In scope:** tracking positions and value, performance review, event-level risk, and hypothetical position changes, across Polymarket and Kalshi, read-only.
- **Out of scope:** trade execution, copy trading, signals or advice, probability forecasts, tax reporting, custody.

## Interaction principles

- **Four independent modules.** Overview, Analytics, Risk and Scenario Lab each answer their own question and are complete on their own. They share one data layer, not each other's screens.
- **Inspect, explore, navigate.** *Inspect* opens a detail panel (position, event, group of holdings, trades) on top of the current page. *Explore* changes a local view (grouping, period, a selected allocation segment) without changing portfolio-wide figures. *Navigate* moves to another module and is always an explicit, labelled action (“Analyze in Risk →”, “Simulate in Scenario Lab”).
- **No navigation just to see data.** Anything shown in one module that is defined in another (an event's exposure, a position's fills) is inspectable in place.
- **Scenario state only changes on purpose.** Nothing outside Scenario Lab edits a scenario. Hand-offs ask which scenario and which holdings to add; new positions start at the current holding and mark; Cancel changes nothing; reloading never repeats a hand-off.
- **One copy of every assumption.** Relationship classifications and guardrails are shared state, editable wherever they are used.
- **Drill-downs keep scope.** A panel opened from a filtered view says which period and platform scope it reflects.

## Terminology (use these words in the UI)

| Term | Meaning |
|---|---|
| Mark | Last traded price on the platform. |
| Cost basis / capital committed | What an open position cost (shares × fill price), excluding fees. |
| Realized / unrealized P&L | From closed trades after their fees / from open positions at mark, before fees. |
| Net P&L | Realized + unrealized − fees on open fills. Never includes deposits. |
| Settlement payoff | $1 per share if your side wins, $0 otherwise. |
| Feasible outcome | A combination of event results that can actually happen given confirmed relationships. |
| Assumed fill price | The price a scenario assumes a trade executes at. Not a quote. |
| Funding shortfall | Extra cash a scenario needs beyond the platform's balance. |

Full definitions: `docs/METHODOLOGY.md`.

## Product copy

- Write for the user of a real product. No development-stage words in the UI ("prototype", "demo", "coming soon", "planned").
- Sample data is always identifiable as **Sample portfolio**. Never claim an account was connected, imported, synced or verified when it wasn't.
- Unavailable actions are removed or disabled with a short reason. They are never simulated.
- Put assumptions and limitations next to the figure they qualify, not in page-wide disclaimers.
