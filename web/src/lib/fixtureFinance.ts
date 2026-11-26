/* The development fixture's calculations: `createFinance` bound to the bundled Sample portfolio.
   Only the fixture workspace service (data/workspace.ts) and tests may import this. Pages and components read the
   selected workspace's instance through `useFinance()`, so a Demo or own portfolio never shows fixture figures.
   (Enforced by lib/boundary.test.ts.) */
import { SAMPLE_PORTFOLIO } from '../data/sample'
import { createFinance } from './finance'

export const FIXTURE = createFinance(SAMPLE_PORTFOLIO)
export const {
  PORTFOLIO, TODAY, HISTORY_START, LAST_VISIT, sourceOf, coverage, ACCOUNTS, accountOf, accountsOn, derivePosition, POSITIONS, POS_BY_ID, positionsFor,
  tradesIn, account, markAt, netPnlAt, depositsAt, series, periodAvailable, periodRange, customRangeIssue, periodStats, sourceRelations, baseHoldings,
  exposures, settlementRangeFor, instrumentOfPosition, holdingsOfInstrument, positionFor, startingValue, startingPoint, simulate, allocation,
  eventRelations, valueBridge,
} = FIXTURE
