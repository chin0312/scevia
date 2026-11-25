/* SAMPLE fee metadata for markets in the sample portfolio and sample market catalog.
   Parameters follow the providers' published formulas (see lib/fees.ts), but they are illustrative: real
   market-specific parameters come from provider data (Phase 2 returns Polymarket `feeRateBps` per market). */
import type { FeeSchedule } from '../lib/fees'
import type { Category, Platform } from './types'

/** Polymarket taker rates by category (published table, 2026-11-25). Elections are 0.05; other politics 0.01. */
const PM_RATE: Record<Category, number> = { Sports: 0.05, Politics: 0.01, Crypto: 0.01, Economics: 0.01, Climate: 0.01 }

export function sampleFeeSchedule(provider: Platform, category: Category, opts: { election?: boolean } = {}): FeeSchedule {
  if (provider === 'pm') {
    const taker = opts.election ? 0.05 : PM_RATE[category]
    return { formula: 'price-variance', taker, maker: 0, rounding: 'nearest-5dp', source: 'sample', reference: `Polymarket published rate for ${opts.election ? 'elections' : category} (sample)`, effective: null }
  }
  return { formula: 'price-variance', taker: 0.07, maker: 0, rounding: 'up-to-cent', source: 'sample', reference: 'Kalshi standard series: taker 0.07, no maker fee (sample)', effective: '2026-07-07' }
}
