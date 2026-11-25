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

Relationship classes:

| Class | Effect on joint outcomes |
|---|---|
| Equivalent contract | Must resolve the same way. In the sample these are merged into one event. |
| Mutually exclusive outcomes | Both can't resolve YES; that combination is excluded. |
| Related but non-equivalent | No constraint. Shown together, never netted. |
| Unknown / unclassified | No constraint. Flagged as an unmodeled dependency. |

**Best and worst cases** enumerate every joint outcome of the events in scope, skip infeasible ones, and take the max/min. Nothing is adjusted after the fact.

- **Portfolio-level figures** (Risk tiles) always use every holding.
- **Table filters** compute their own subtotal range and never change portfolio figures.
- An **empty filter** has no range, which is different from "no risk".

## Scenarios

A scenario is a list of adjustments: target shares for a position at an **assumed fill price** (0.01–0.99).

- **Buy:** cost basis += shares × price; cash −= shares × price + estimated fee. Realized P&L is unchanged.
- **Sell / exit:** realized += shares × (price − average cost) − fee; cost basis falls in proportion; cash += proceeds − fee.
- **Fees:** optional estimate at each platform's rate (`feeRates`, as a share of notional).
- **Results are expressed as portfolio value:**
  - "Value at mark" changes only by the gap between the assumed price and the mark, plus fees, so a purchase never shows as profit;
  - "Value if worst/best feasible outcome" = cash + $1 per winning share.
- **Invalid input** (price outside 0.01–0.99): that adjustment is left out of the results, and the scenario can't be saved until it's fixed.
- **Funding shortfall:**
  - when purchases exceed a platform's cash, the trades stay in the results as if funded;
  - cash goes negative by the shortfall, so values remain comparable and net of the extra funding;
  - the shortfall per platform is shown. Scenarios with a shortfall can be saved: it's an exploration, not an order.
- **Saved scenario** = name + adjustments. It is always evaluated under the current global assumptions (fee estimate, relationships), so a comparison uses one set of assumptions.
