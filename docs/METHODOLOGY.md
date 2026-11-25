# Calculation methodology

How every figure in Scevia is derived. The implementation is `web/src/lib/finance.ts`; tests are in `web/src/lib/*.test.ts`. If this document and the code disagree, the code is wrong or this file is stale, so fix one of them in the same change.

## Data model

All calculations read one `PortfolioData` object (`web/src/data/types.ts`):

| Field | Meaning |
|---|---|
| `cashFlows` | Deposits (> 0) and withdrawals (< 0) per platform. |
| `openPositions[].fills` | Buys that make up each open position: date, shares, price, fee. |
| `openPositions[].mark` | Last traded price on the platform. `markAtLastVisit` is the mark at the previous visit. |
| `closedTrades` | Round trips that resolved (`Won`/`Lost`) or were sold early, with total fees and whether those fees were reported (`feeKnown`). |
| `events` | The event that decides each position's payoff. Positions on the same outcome across platforms share an event. |
| `relations` | Known relationships between events (see below). |
| `asOf`, `historyStart`, `lastVisit` | "Today", the first date with data, and the previous visit. |

The app imports data only through `web/src/data/portfolio.ts`.

## Account figures

| Figure | Definition |
|---|---|
| Cost basis (capital committed) | Σ shares × fill price of open positions. Fees are not included. |
| Unrealized P&L | Σ shares × (mark − average cost), before fees. |
| Realized P&L | Σ over closed trades of shares × (exit − entry) − that trade's fees. Resolved trades exit at $1 or $0. |
| Fees paid | Closed-trade fees + fees on fills of open positions. Each fee is counted once. |
| Net P&L | Realized + unrealized − fees on open fills. |
| Net deposits | Deposits − withdrawals. Never performance. |
| Cash | Net deposits + realized − Σ (cost + fees) of open fills, per platform. |
| Portfolio value | Cash + Σ shares × mark. **Invariant:** value − net deposits = net P&L. |
| Win rate | Trades that resolved in your favour ÷ resolved trades. Early exits are excluded. |
| Allocation share / weight | A position's or segment's shares × mark ÷ Σ shares × mark of open positions in the current platform scope. Cash is excluded. Segment shares sum to 100%, and each segment's positions partition it (`allocation()`). |

Platform filters apply the same formulas to that platform's records. Platform figures always sum to the total.

## History

Weekly snapshots from `historyStart`, plus `asOf`.

- **Open positions:** each position's mark follows a path from its first fill price, through `markAtLastVisit` at the previous visit, to today's mark.
- **Closed trades:** the mark moves from entry to exit.
- **Fees:** closed-trade fees are recognised at close; open-fill fees at the fill date.

Each platform's curve is its own history, never a scaled copy of the total.

> The sample's intermediate marks are synthetic paths between real anchors. With real data they should come from platform price history. Until then, anything measured *between* snapshots (for example intraweek drawdown) can't be seen.

## Periods

- **Ranges:** 1M = 30 days, 3M = 91 days, 6M = 182 days, YTD from Jan 1, All from `historyStart`. A trade belongs to the period in which it **closed** (start exclusive, end inclusive), so consecutive periods never double count.
- **Period net P&L:** net P&L at the end minus net P&L at the start. Deposits are excluded by construction.
- **Decomposition:** net = realized + change in unrealized − fees on new fills.
  - Realized counts each trade closed in the period **in full**, including P&L that built up before the period started. That earlier part reappears as a negative contribution in "change in unrealized", so the rows always add up.
- **Prior period:**
  - same-length window immediately before;
  - for YTD, the same calendar span last year;
  - shown as unavailable when it starts before `historyStart`.
- **Largest drawdown:** the largest peak-to-trough fall in cumulative net P&L **on weekly snapshots** within the period.

## Descriptive patterns

Analytics shows a pattern only when it has at least 5 trades. It always shows the sample size, and labels anything under 30 trades as a small sample. Patterns describe what happened; they are not statistical evidence of skill.

- **Longshots:** resolved trades with entry price below $0.25. Compares the win rate with the average entry price.
- **Early exits:** opportunity cost in hindsight.
  - What holding would have paid on exits whose event later resolved in your favour, vs. value kept on exits whose event went to $0.
  - The outcome wasn't known at exit time, so this doesn't show the exit was a mistake.
- **Largest contributor:** the category with the highest net realized P&L. It is measured on the same basis as attribution, so the two always match. It says nothing about consistency.

## Settlement and relationships

- **Payoff:** a contract pays $1 per share if its side wins, otherwise $0.
- **Event P&L for an outcome:** Σ payout − cost basis of that event's positions (fees already paid are excluded).
- **Event exposure** (`eventExposureOf`) evaluates **both outcomes explicitly**. For each outcome, every holding is paid by its own side: P&L(YES) = Σ YES shares − cost, P&L(NO) = Σ NO shares − cost. Opposing holdings on the same event therefore offset at settlement.
  - Capital committed stays the gross cost. Example: 100 YES @ $0.60 + 60 NO @ $0.40 → cost $84, P&L(YES) = +$16, P&L(NO) = −$24.
  - **Single-sided** events are labelled for / against the user.
  - **Mixed** events (side `Mixed`) are labelled by outcome (If YES / If NO), and "best" / "worst" are simply the better and worse outcome.
  - **Max loss** = max(0, −min(P&L(YES), P&L(NO))). It is used by the downside ladder, the top-3 / busiest-week losses and the largest single-event loss in scenarios. Concentration and guardrails stay on gross capital committed.
  - The same per-holding payout rule drives portfolio best/worst cases, so event and portfolio figures agree (tested).
- **Binary assumption:** every contract settles at $1 or $0 on YES/NO. Multi-outcome markets, partial or non-$1 settlements (which the backend models; see `backend/docs/FRONTEND_INTEGRATION.md` in PR #3), and automated cross-platform matching are not modelled. They will follow provider data.

Relationship classes:

| Class | Effect on joint outcomes |
|---|---|
| Equivalent contract | Must resolve the same way. In the sample these are merged into one event. |
| Mutually exclusive outcomes | Both can't resolve YES; that combination is excluded. |
| Related but non-equivalent | No constraint. Shown together, never netted. |
| Unknown / unclassified | No constraint. Flagged as an unmodeled dependency. |

**Best and worst cases** enumerate every joint outcome of the events in scope, skip infeasible ones, and take the max/min. Nothing is adjusted after the fact.

**Enumeration cap.**
- **The cost:** exact enumeration takes 2^n combinations for n events.
- **The cap:** above `MAX_JOINT_EVENTS` (16 events), the range is reported as **unavailable**. It is never approximated, and the enumerator refuses to run.
- **Why 16:** it keeps the count and the mask arithmetic far inside safe limits; JavaScript bitwise operators are 32-bit.
- **Before unrestricted real portfolios:** a bounded or decomposed method is needed that preserves exactness. For example, events with no constraints between them separate, so their extremes add independently.

- **Portfolio-level figures** (Risk tiles) always use every holding.
- **Table filters** compute their own subtotal range and never change portfolio figures.
- An **empty filter** has no range, which is different from "no risk".

## Scenarios

A scenario is a **hypothetical portfolio**:
- a starting point;
- optional added capital;
- scenario-level assumptions;
- positions, each with a target quantity at an **assumed price** (0.01–0.99).

It is evaluated by `simulate()`, the same engine for every mode. Actual holdings, cash and history never change.

**Starting points.**
- **Current portfolio:** the actual holdings and per-platform cash from the selected sources.
- **Empty portfolio:** no holdings, no cash, no history.

Each scenario is measured against **its own starting point**: the baseline plus added capital, with no trades.

**Added capital** is per platform and explicit:
- It is contributed capital: it raises cash and the starting value equally, and is never counted as a gain.
- It is validated: 0 to 100,000,000. Invalid values are ignored by the engine, flagged in the UI and block Save.
- Cash is never moved between platforms. A purchase beyond one platform's cash is that platform's shortfall.

**Positions.**
- **Held instrument:** an actual position, by its position id. It starts at its current quantity and mark ("No change").
- **New instrument:** keyed by `provider:marketId:outcome` and carrying an instrument reference:
  - provider, event, market and outcome;
  - category and resolution date;
  - reference price and timestamp;
  - the source (sample or provider).

  It starts at zero shares. It is valued at its reference price; if there is none, market value and allocation are **unavailable**, never 0.
- **Quantities** are whole shares from 0 to 10,000,000. This is a temporary assumption: real providers may allow fractional shares.
- **Incomplete or invalid rows are excluded from results and block Save.** A missing quantity or price is never read as 0.

**Trades.**
- **Buy:** cost basis += shares × price; cash −= shares × price + estimated fee. Realized P&L is unchanged.
- **Sell / exit:** realized += shares × (price − average cost) − fee; cost basis falls in proportion; cash += proceeds − fee.
- **Fees:** per scenario, estimated (default) or excluded, at each platform's rate (`feeRates`, a share of notional). These are sample rates. Slippage and order-book depth are not modelled.

**Results are expressed as portfolio value.**
- "Value at mark" changes only by the gap between the assumed price and the reference price, plus fees.
- "Value if worst/best feasible outcome" = cash + $1 per winning share. These are unavailable above 16 events.
- Any change whose either side is unavailable is itself unavailable. It is never coerced to 0.

**Funding shortfall.**
- When purchases exceed a platform's cash, the trades stay in the results as if funded, and cash goes negative.
- The shortfall is shown per platform.
- It is a property of the scenario, not an input error, so the scenario can still be saved.

**Assumptions.**
- **Shared:** facts from sources (holdings, cash, marks) and the portfolio's relationship classification, used by Risk and by every scenario that doesn't override it.
- **Per scenario:**
  - starting point;
  - added capital;
  - fee treatment;
  - an optional **BTC × ETH override**, which affects only that scenario and never Risk or other scenarios.

**Allocation impact.**
- Market value (shares × reference price) is grouped by category, platform or event, before and after.
- **Denominator:** open-position market value, with cash excluded. Cash share = cash ÷ (cash + open-position value).
- Allocation is not capital committed and not settlement loss.

**Comparison.**
- Each column shows its starting point, added capital and assumptions.
- Each change is shown "vs. start", that is, against that scenario's own starting point, so added capital and different baselines are not read as performance.
- Columns with different starts are flagged.

**Saved state.**
- A save snapshots name, positions, starting point, added capital and assumptions.
- Revert restores the snapshot. Reset returns a never-saved scenario to its start: empty, the duplicate's source or the example.
- Stored scenarios from older formats migrate to "current portfolio" with shared assumptions.
