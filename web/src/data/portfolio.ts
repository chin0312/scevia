/**
 * The single place the app gets its portfolio from.
 *
 * Today this is the bundled sample. When real account data arrives, replace this module with a loader
 * (and, once data becomes asynchronous, provide it through React context instead of module constants).
 * Nothing else should import from `./sample`.
 */
import { SAMPLE_PORTFOLIO } from './sample'
import type { PortfolioData } from './types'

export const PORTFOLIO: PortfolioData = SAMPLE_PORTFOLIO

export const TODAY = PORTFOLIO.asOf
export const HISTORY_START = PORTFOLIO.historyStart
export const LAST_VISIT = PORTFOLIO.lastVisit
export const CASH_FLOWS = PORTFOLIO.cashFlows
export const OPEN_POSITIONS = PORTFOLIO.openPositions
export const CLOSED_TRADES = PORTFOLIO.closedTrades
export const EVENTS = PORTFOLIO.events
export const SOURCES = PORTFOLIO.sources
