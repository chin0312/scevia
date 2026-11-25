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
| Cost basis (capital committed) | Σ (shares × fill price + fill fee) of open positions: weighted-average cost with acquisition fees capitalized. This is the backend accounting convention (`backend/docs/ACCOUNTING.md`, Phase 3). |
| Average cost | Cost basis ÷ shares (includes acquisition fees). |
| Unrealized P&L | Σ shares × mark − cost basis of open positions (after acquisition fees). |
| Realized P&L | Σ over closed trades of shares × (exit − entry) − that trade's fees. Resolved trades exit at $1 or $0. Sale fees reduce proceeds. |
| Fees paid | Closed-trade fees + fees on fills of open positions (the latter are inside cost basis). Each fee is counted once. |
| Net P&L | Realized + unrealized. |
| Net deposits | Deposits − withdrawals. Never performance. |
| Cash | Net deposits + realized − cost basis of open positions, per platform. |
| Portfolio value | Cash + Σ shares × mark. **Invariant:** value − net deposits = net P&L. |
| Win rate | Trades that resolved in your favour ÷ resolved trades. Early exits are excluded. |
| Allocation share / weight | A position's or segment's shares × mark ÷ Σ shares × mark of open positions in the current platform scope. Cash is excluded. Segment shares sum to 100%, and each segment's positions partition it (`allocation()`). |

Platform filters apply the same formulas to that platform's records. Platform figures always sum to the total.

**Changed in this round (alignment with backend Phase 3).** Earlier versions kept acquisition fees out of cost basis and
subtracted them separately in net P&L. Net P&L, cash and portfolio value are unchanged by the switch; cost basis, average
cost, unrealized P&L, per-event capital at risk and "change in unrealized" (Analytics) now include acquisition fees.
Tests: `finance.test.ts › account identities`, `periods and analytics`.

**Ownership.** These are calculations over the *sample* ledger. For actual portfolios, the backend replay
(weighted average, decimal arithmetic, evidence decisions, settlement entitlements separate from cash) is the accounting
authority; the frontend will consume its holdings, cash and availability fields rather than keep a second ledger
(see `docs/DEVELOPMENT.md › Accounting ownership`). Remaining differences until then:

| Topic | Frontend sample | Backend Phase 3 |
|---|---|---|
| Numbers | JavaScript numbers | Decimal strings, 70-digit working precision, half-even rounding |
| Fees | Always known for open fills; closed trades have `feeKnown` | Reported / estimated / unavailable; an unavailable buy fee invalidates basis |
| Settlement | Pays $1/$0 directly into cash | Records an entitlement; cash moves on redemption |
| Partial exits | Closed trades are pre-aggregated | Buy/sell fills replayed with weighted average |
| Missing marks / opening balances | Not modelled (sample is complete) | Valuation is null; known components are scoped |
| Evidence decisions | None in the portfolio (see the sample records workspace) | Include / exclude / duplicate / correct / restore, append-only |

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

**Event relationships are settlement logic, not correlation.**
- They say which **joint outcomes are possible**. They never say how likely anything is.
- Excluding a combination changes the deterministic best/worst range, never a probability.
- Scevia doesn't estimate correlation and doesn't assume that unrelated events are independent.

| Class | Effect on joint outcomes |
|---|---|
| Equivalent settlement | Must resolve the same way. Equivalent contracts share a settlement group (`eventId`) and are merged into one event. |
| Mutually exclusive outcomes | Both can't resolve YES; that combination is excluded. |
| Related, no constraint | Every combination stays possible; nothing is netted. A descriptive note. |
| Unknown / unclassified | No constraint. This is not an assumption of independence; it simply removes nothing. |

**Provenance** (`Relation.provenance`) decides whether a relationship constrains:

| Provenance | Where it comes from | Constrains? | Used by |
|---|---|---|---|
| `verified` | Source facts: settlement rules or a reviewed source relationship | Yes (equivalent / mutex) | Risk and every scenario |
| `annotation` | Descriptive notes (e.g. "US macro outlook") | **Never**, whatever its class: a note can't remove a possible loss | Display only |
| `hypothetical` | A scenario's own constraint (Setup → Settlement constraints) | Yes, in that scenario only | That scenario's best/worst, matrix and comparison |

- **Risk** uses source relationships only (`sourceRelations()`).
- **A scenario** uses `withConstraints(sources, constraints)`. A pair that already has a verified relationship can't be overridden, and duplicate pairs are ignored.
- **Inconsistent constraints:**
  - With binary mutex/equivalent constraints, "everything resolves NO" is always feasible, so a range always exists.
  - The engine still returns *unavailable* (`rangeIssue = 'no-feasible-outcome'`), never Infinity, if a future constraint type ever leaves no feasible outcome.
- **Sample data:**
  - The Fed contracts on Kalshi and Polymarket share a settlement group (verified equivalence in the sample).
  - Fed / CPI / recession carry a "related" annotation.
  - There are no other constraints. Older stored scenarios that set the sample BTC × ETH pair to mutually exclusive are migrated to a hypothetical constraint in that scenario only.
- **Later, only if provider structures justify it:**
  - mutually exclusive outcome sets (e.g. Polymarket negative-risk events, where at most one market resolves YES);
  - "exactly one" constraints;
  - cross-provider equivalence after review.

  These would arrive as verified source facts, not frontend inference.

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
- **Quantities** are from 0 to 10,000,000 in steps of 0.01 share (the hypothetical input step). Venue lot sizes and minimums aren't enforced: they will come from instrument metadata, and no exchange rule is invented meanwhile.
- **Sizing.** A target can be entered three ways that describe the same position (`targetShares`):
  - *Shares*: the quantity.
  - *$ Amount*: the target position value **at the assumed price**; shares = amount ÷ price, rounded **down** to 0.01 (never spends more than typed). Fees are on top.
  - *% of start*: a percentage of the scenario's **starting value at reference marks** (cash and added capital included); amount = % × starting value, then as above.
  Switching the view converts the display only. Typing sets the target in that unit, and the typed unit is saved, so a later price change keeps the typed amount, not the share count. A % of start is not a market-value weight: if the assumed price differs from the mark, the position's weight at marks differs (tested).
- **Incomplete or invalid rows are excluded from results and block Save.** A missing quantity or price is never read as 0.

**Trades.**
- **Buy:** cost basis += shares × price + estimated fee (acquisition fees are capitalized); cash −= shares × price + estimated fee. Realized P&L is unchanged.
- **Sell / exit:** realized += shares × (price − average cost) − fee; cost basis falls in proportion; cash += proceeds − fee.
- **Fees:** see *Trading fees on hypothetical trades* below. Slippage and order-book depth are not modelled.

**Trading fees on hypothetical trades** (`lib/fees.ts`, `estimateFee`, used by the engine; the UI only shows what the engine computed).
- **Published structure,** checked 2026-11-25:
  - **Polymarket:** fee = C × feeRate × p × (1 − p).
    - Takers only; makers pay 0.
    - The rate is set per market or category: 0.05 for sports, elections and similar; 0.01 for crypto, economics, weather and similar; 0 for fee-free categories.
    - Fees are rounded to 5 decimals.
    - Source: docs.polymarket.com/trading/fees.
  - **Kalshi:** taker = round up(0.07 × C × P × (1 − P)) to the next cent.
    - Maker fees (0.0175 ×) apply only on non-standard series, and series multipliers can differ.
    - The schedule took effect 2026-07-07.
    - The official page couldn't be opened from our network, so these figures come from published summaries of the schedule. Re-verify against the official PDF before relying on them for real data.
- **Modes per scenario:**
  - *Provider estimate* (default): uses each market's fee parameters and an **assumed order role**. Taker is the default; the user can choose maker. Whether an order fills as maker or taker isn't known in advance.
  - *Custom*: a % of notional (0–10%), rounded up to the cent.
  - *Excluded*: trades shown before fees.
- **Missing parameters:** a market without fee parameters gives an **unavailable** fee, never $0.
  - The trade stays in the results before that fee, and it is flagged on the row.
  - The fees row reads "+ unavailable", and the before/after footnote explains it.
  - A custom fee includes it.
- **Parameters in this build:** illustrative sample values based on the published formulas (`data/sampleFees.ts`), stored on the market (`FeeSchedule`, with source, reference and effective date). In Phase 2 they come from provider metadata (e.g. Polymarket `feeRateBps` per market).
- **Historical fees** are source records (reported, estimated or unavailable) and are **never** recalculated with today's schedules or scenario settings (tested).

**Inputs.**
- **Parsing:** quantities, prices, capital and fee % are parsed strictly (`lib/inputs.ts`).
  - Scientific notation, signs, and extra decimals are rejected.
  - Prices take up to 3 decimals; shares and money take up to 2 decimals.
- **While a field is empty, being typed or invalid, the row has no value** for it: it is excluded or marked invalid, and the previous value is never reused.

**Results are expressed as portfolio value.**
- "Value at mark" changes only by the gap between the assumed price and the reference price, plus fees.
- "Value if worst/best feasible outcome" = cash + $1 per winning share. These are unavailable above 16 events, or if constraints leave no feasible outcome.
- **"Worst single-event outcome"** is shown as a signed settlement outcome (−$5,000 → −$3,000 is an improvement of +$2,000).
  - Higher is better; the delta, colour and text agree.
  - Fees and funding shortfall: lower is better.
  - Cash, capital committed, positions at mark and events held are transfers or counts, and are never judged better or worse.
- Any change whose either side is unavailable is itself unavailable. It is never coerced to 0.

**Funding shortfall.**
- When purchases exceed a platform's cash, the trades stay in the results as if funded, and cash goes negative.
- The shortfall is shown per platform.
- It is a property of the scenario, not an input error, so the scenario can still be saved.

**Assumptions.**
- **Shared facts** (never edited in a scenario): holdings, cash, marks, verified relationships and market fee parameters.
- **Per scenario:**
  - starting point;
  - added capital;
  - fee treatment (provider estimate with an assumed role, custom, or excluded);
  - optional **hypothetical settlement constraints** between events in that scenario.

**Hand-offs and starting points.**
- **Into a current-portfolio scenario:** a hand-off adds a held position at its current quantity and mark (no trade).
- **Into an empty-portfolio scenario:** the position is added from zero with no quantity or price. The user can explicitly choose "copy my current quantities as purchases".
- **Switching an existing scenario's starting point:** asks whether to keep target quantities (which then mean something else) or reset held positions. The ask appears only when held positions would change meaning.

**Funding and allocation.**
- Added capital, available cash, cash after trades, funding shortfall, open-position value and net value are shown separately.
- Negative cash is a **funding need**, shown as such ("needs $X funding"). It is never clamped to 0, and never shown as a negative or ordinary cash share.

**Saved definition vs. market data.**
- The saved state is what the user controls:
  - name and starting point;
  - capital, fees and constraints;
  - positions with instrument identity (provider, market, outcome), quantities and assumed prices.
- Reference prices, timestamps and fee parameters are a market-data snapshot carried with each new instrument. Refreshing them doesn't make a scenario "unsaved"; results show the reference time.
- Identity is **provider + market + outcome**. Sharing an event and a side doesn't make two positions the same contract.

**Analysis (Scenario Lab › Analyze).** Each chart answers one question and has an exact table or text equivalent.

| View | Definition |
|---|---|
| Summary | Value at reference marks and feasible settlement range are primary; cash after trades, capital committed, estimated fees and funding required are secondary. Each shows its start value. |
| Value bridge | Start value (before added capital) + added capital + Σ traded shares × (mark − assumed price) − estimated fees = scenario value at marks. Purchases and sales themselves are transfers between cash and contracts, never gains or losses. Unavailable when a traded instrument has no mark. Reconciles exactly (`workspace.test.ts`). |
| Settlement range | Worst and best feasible value (cash + $1 per winning share) at the start and in the scenario, with the value at marks marked. No midpoint or distribution is drawn: outcomes are not weighted by likelihood. |
| Allocation | Market value at reference marks by category, platform or event. One denominator per view: *open positions* (cash excluded) or *incl. cash* (cash + positions). Cash-inclusive is unavailable when cash is negative (a funding requirement). Selecting a segment filters the position table. |
| Event exposure | Per event, all holdings netted: worst settlement P&L (min over outcomes, vs. cost basis) or capital committed (cost basis incl. fees), before → after. |
| Resolution timeline | Committed capital still exposed after each month, by **scheduled resolution date**. Resolution is not a confirmed redemption date; cash timing is not modelled. |
| Outcome matrix | P&L of two events' positions in each joint outcome. A cell is "Not possible" when it can't be extended to a feasible outcome of the whole scenario: constraints are followed through other events (A ≡ B and B × C ⇒ A and C can't both be YES), so a pair never looks possible when the portfolio isn't. The cell names the linked constraints and their provenance. |
| Positions in detail | Start and scenario shares, trade, notional, fee, value at mark and cost basis per position. |

**Comparison (Scenario Lab › Compare).**
- The user picks up to five scenarios (and whether to show the actual portfolio).
- Bases: *absolute*; *change from start* (value − the scenario's own starting value at marks); *% of own start* (only when that starting value is positive; otherwise unavailable).
- Scenarios are flagged as differently set up when any of these differ: starting portfolio, added capital **per venue** (equal totals on different venues are different funding), fee treatment, constraints, or the date of the actual portfolio they start from.

**Comparison table.**
- Each column shows its starting point (with the portfolio date), added capital by venue, starting value and assumptions.
- Each change is shown "vs. start", that is, against that scenario's own starting point, so added capital and different baselines are not read as performance.

**Saved state.**
- A save snapshots name, positions, starting point, added capital and assumptions.
- Revert restores the snapshot. Reset returns a never-saved scenario to its start: empty, the duplicate's source or the example.
- Stored scenarios from older formats migrate to "current portfolio" with shared assumptions.
- A current-portfolio scenario records the date of the portfolio it started from (`baseAsOf`). If the actual portfolio has moved on, the scenario says so ("created from your portfolio as of …") instead of silently rebasing.
- The sizing unit (`size`) is part of the saved state.
