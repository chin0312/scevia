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
