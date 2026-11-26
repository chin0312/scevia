/* Contextual help and methodology, in one place. Info tips on figures use the short definitions in HELP; Help ›
   Methodology lists the same definitions by concept, so an explanation moved off a dashboard stays discoverable
   and a concept used in several modules has one definition. Full methods and formulas are in docs/METHODOLOGY.md. */

export const HELP = {
  marks: 'Mark: the last traded price on the platform, used to value open positions. Values exclude estimated exit fees. Weight: share of all open-position market value in the current platform scope, also when Holdings are filtered.',
  attribution: 'Realized P&L counts each trade closed in the period in full, after its fees, including gains or losses that built up before the period began. That earlier part is reversed in Change in unrealized, which is also after fees on new purchases, so the rows add up to the period’s net P&L.',
  calibration: 'For each entry-price bucket: how often resolved trades won, against the win rate the average entry price implied. Buckets with fewer than 30 trades can differ from the implied rate by chance, so treat a gap as something to watch, not a verdict.',
  twr: 'Time-weighted return links each interval’s return after removing deposits and withdrawals, so new money is never a gain. Here it uses weekly valuations with flows assumed at the end of each week, so it’s an estimate. Drawdown is the fall of that index from its prior peak, measured at the sampled dates, so a deeper fall between samples isn’t seen. It’s a different measure from the money drawdown of cumulative P&L in Period comparison. Money-weighted return needs dated investor cash flows and volatility needs daily valuations; both come from the accounting service.',
  monthly: 'Each week’s flow-adjusted return is counted in the month the week ends in, and compounded. A week that starts in the previous month is counted whole, so a month’s figure isn’t an exact calendar-month return. The first and last months of the period are partial. Exact calendar-period returns come from the accounting service.',
  patterns: 'Closed trades grouped by one attribute. Win rate counts trades that resolved at $1 or $0 only; sales before resolution are excluded from it. Return on entry is net P&L ÷ shares × entry price. An entry price is the market’s price when you bought, not a verified probability, and a past cohort’s result doesn’t predict future ones.',
  exposureBasis: 'Cost basis: what you paid, including purchase fees. Market value: shares × latest mark, so positions without a mark are counted as missing, not zero. HHI is the sum of squared shares; effective exposures is 1 ÷ HHI. It describes how spread out the sizes are, not how many independent risks you hold.',
  settlementPaths: 'Settlement P&L by event under the portfolio’s worst and best feasible joint outcome. The rows add up to that one outcome; they aren’t each event’s own worst case. Gross payout is what the contracts pay at $1 or $0; change from current value compares it with today’s marks.',
  timing: 'Capital committed by scheduled resolution date. Overdue means the scheduled date has passed without a recorded settlement. A schedule isn’t a guarantee of settlement, redemption or when cash becomes available.',
  worstCase: 'Lowest settlement P&L of the whole portfolio across joint outcomes that are possible given confirmed relationships. Unclassified pairs can go either way. Not affected by table filters.',
  downsideLadder: 'Settlement loss if your N most exposed events all go against you. It adds events as if they could fail together and says nothing about how likely that is.',
  payoffs: 'Settlement P&L against cost basis, including purchase fees, if each event resolves YES or NO. Best and worst cases search every possible joint outcome and skip impossible ones. Related and unclassified events keep every combination and are never netted.',
  relationships: 'Relationships are settlement logic with provenance, not correlation. Only verified constraints (equivalent or mutually exclusive) remove joint outcomes. Related, unclassified and unknown pairs keep every combination. Hypothetical constraints exist only inside a scenario.',
  calendar: 'Capital committed by scheduled resolution date. Circle size is the capital at stake. A scheduled date isn’t a guarantee of settlement or of when cash becomes available.',
  concentration: 'Capital committed to one event as a share of capital committed to all events. The same outcome on two platforms counts once. The concentration limit only flags events.',
  valueBridge: 'Cash plus positions at reference prices. Buying above the reference price or selling below it lowers value by the difference, and fees lower it further. Added capital is part of the start, never a gain.',
  settlementRange: 'Worst and best portfolio value at settlement across possible joint outcomes. It isn’t a distribution: outcomes between the ends aren’t more likely, and the middle isn’t an expected value. Constraints apply only to their own scenario.',
  feeRole: 'Fees use each market’s published parameters and an assumed role. Taker: your order fills against a resting one. Maker: your resting order is filled. Actual fees depend on each market’s schedule and can differ.',
  frozenStart: 'A scenario keeps the starting portfolio and reference prices from when it started. Check latest compares prices and updates only if you confirm. Updating the starting portfolio replaces holdings, cash and prices but keeps your simulated trades.',
  replayExecution: 'Entry and exit prices are your assumptions, not recorded fills. Positions settle at each market’s recorded outcome where one is verified. Markets are chosen knowing how they turned out, so results are hindsight analysis.',
  compareBasis: 'Each scenario is measured against its own start. Changes exclude added capital. Green is better for you, red is worse, grey is a transfer or a count.',
} as const

export type HelpKey = keyof typeof HELP

/** Help › Methodology, by concept. */
export const METHODOLOGY: { section: string; items: [string, string][] }[] = [
  { section: 'Portfolio valuation', items: [
    ['Portfolio value', 'Cash plus open positions at their mark (last traded price). With connected accounts, settlement entitlements not yet redeemed are added as their own component.'],
    ['Cash', 'Per platform account, in its own asset. USD and USD stablecoins aren’t converted into each other.'],
    ['Cost basis', 'Weighted-average cost of open positions, including purchase fees. Sale fees reduce proceeds.'],
    ['Marks and weights', HELP.marks],
    ['Fees', 'Reported, estimated (labelled) or unavailable. Unknown values stay unavailable, never $0.'],
  ] },
  { section: 'Performance', items: [
    ['Realized and unrealized P&L', 'Realized: closed trades after their fees. Unrealized: open positions at mark minus cost basis.'],
    ['Net P&L', 'Realized plus unrealized. Deposits and withdrawals are never performance.'],
    ['Period attribution', HELP.attribution],
    ['Drawdown', 'Largest fall of cumulative net P&L from a previous high, on weekly history.'],
    ['Market price and implied probability', 'For a standard YES/NO contract the price is the market-implied probability: the market’s price, not Scevia’s forecast. Your historical win rate is a separate, observed measure.'],
    ['Entry price vs. outcome', HELP.calibration],
    ['Returns and drawdown', HELP.twr],
    ['Monthly returns', HELP.monthly],
    ['Trading patterns', HELP.patterns],
    ['Time-weighted return', 'Return with external capital flows removed, linking periods between flows. Needs complete valuation history (with connected accounts).'],
  ] },
  { section: 'Risk', items: [
    ['Concentration', HELP.concentration],
    ['Event exposure', 'All holdings on one event netted: YES and NO positions offset at settlement.'],
    ['Settlement payout', 'A contract pays $1 per share if its outcome wins and $0 otherwise. Settlement gain or loss is payout minus cost basis.'],
    ['Worst-case settlement P&L', HELP.worstCase],
    ['Exposure basis and concentration', HELP.exposureBasis],
    ['Settlement paths', HELP.settlementPaths],
    ['Resolution timing', HELP.timing],
    ['Outcome payoffs', HELP.payoffs],
    ['Downside ladder', HELP.downsideLadder],
    ['Event relationships', HELP.relationships],
    ['Resolution calendar', HELP.calendar],
  ] },
  { section: 'Scenario Lab', items: [
    ['Virtual capital', 'Starting or added capital in a scenario is simulated. It isn’t a deposit, never counts as a gain and stays on its platform.'],
    ['Frozen starting portfolio', HELP.frozenStart],
    ['Value at reference prices', HELP.valueBridge],
    ['Settlement range', HELP.settlementRange],
    ['Fee assumptions', HELP.feeRole],
    ['Comparing scenarios', HELP.compareBasis],
  ] },
  { section: 'Historical Replay', items: [
    ['Execution and hindsight', HELP.replayExecution],
    ['Historical prices', 'Each contract is valued at its last recorded price until a newer one arrives (never a later price for an earlier date), keeping the original time. After settlement a contract is worth its payout. Without an earlier price, a value is unavailable.'],
    ['Funding', 'Each position is funded from virtual funds on its platform in its settlement currency. Funds never move between platforms or currencies.'],
  ] },
  { section: 'Data coverage', items: [
    ['Sample, Demo and your portfolios', 'Sample: fictional markets and records for exploring. Demo: virtual capital and hypothetical records on approved real-market data. Yours: connected accounts, imports and manual records. They never mix.'],
    ['Data freshness', 'Market data, account data, valuation, history, sync and sources each have their own state. One current stream never makes another look current.'],
    ['Partial results', 'When some components are known and others aren’t, known parts are shown as such and totals are partial or unavailable.'],
  ] },
  { section: 'Currency conversion', items: [
    ['Native assets', 'Each account keeps its own asset (USD, USDC or pUSD). Converting for display never moves funds.'],
    ['Reporting currency and rates', 'Values can be shown in USD, EUR or GBP. A reference rate is selected automatically for each conversion. Settings › Rates in use lists them. An out-of-date or missing rate is flagged next to the affected figures.'],
  ] },
]

/** Product-level statements, shown once in Help › About rather than on every page. */
export const PRODUCT_POLICIES: string[] = [
  'Scevia is read-only. It never places trades, holds funds or asks for private keys or seed phrases.',
  'Figures, scenarios and replays are analysis, not forecasts, recommendations or investment advice.',
  'Scenario Lab and Historical Replay use virtual capital. They never change your accounts or actual holdings.',
  'Scevia doesn’t estimate how likely an outcome is. Market prices are the market’s, not Scevia’s.',
]
