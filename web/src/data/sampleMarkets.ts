/* SAMPLE market data for Scenario Lab (fictional; not live provider quotes).
   A few markets overlap the sample portfolio's events (same settlement groups), the rest are markets the sample
   portfolio doesn't hold, so new positions, opposing positions and multi-market events can be explored.
   Fee parameters are sample values based on the published formulas; one market (US unemployment) has none, to show
   how an unavailable fee is handled. Listing dates are sample lifecycle values; trading close is recorded only for the resolved market (others: unknown, never inferred from the expected resolution date); no historical prices are included. Replaced by backend market lookup in Phase 2. */
import { fixtureCatalog, type CatalogEvent, type CatalogMarket } from '../lib/markets'
import { TODAY } from './portfolio'
import { sampleFeeSchedule } from './sampleFees'

const yesNo = (yes: number | null) => [{ outcome: 'YES' as const, refPrice: yes }, { outcome: 'NO' as const, refPrice: yes == null ? null : Math.round((1 - yes + 0.01) * 100) / 100 }]
const m = (p: Omit<CatalogMarket, 'outcomes' | 'refAsOf' | 'status' | 'rules' | 'fee' | 'listedAt' | 'closesAt'> & { yes: number | null; status?: CatalogMarket['status']; rules?: string; fee?: CatalogMarket['fee']; election?: boolean; listed: string; closes?: string }): CatalogMarket => ({
  provider: p.provider, marketId: p.marketId, marketTitle: p.marketTitle, settlementGroup: p.settlementGroup, category: p.category, resolves: p.resolves,
  status: p.status ?? 'open', rules: p.rules ?? 'Resolves YES if the stated condition is met by the resolution date, per the provider’s market rules.',
  outcomes: yesNo(p.yes), refAsOf: p.yes == null ? null : TODAY,
  fee: p.fee === undefined ? sampleFeeSchedule(p.provider, p.category, { election: p.election }) : p.fee,
  listedAt: p.listed, closesAt: p.closes ?? null, resolution: p.resolution ?? null,
})

export const SAMPLE_MARKET_EVENTS: CatalogEvent[] = [
  // Events the sample portfolio already holds (settlement groups match its event ids).
  { provider: 'pm', eventId: 'pm-ev-btc', eventTitle: 'Bitcoin above $150k on Dec 31', url: 'https://polymarket.com/event/bitcoin-above-150k-on-december-31', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-btc-150k', marketTitle: 'Bitcoin above $150k on Dec 31', settlementGroup: 'btc', category: 'Crypto', resolves: '2026-12-31', listed: '2025-12-01', yes: 0.29 })] },
  { provider: 'pm', eventId: 'pm-ev-fed-dec', eventTitle: 'Fed decision in December', url: 'https://polymarket.com/event/fed-decision-in-december', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-fed-dec-cut', marketTitle: 'Fed rate cut in December?', settlementGroup: 'fed', category: 'Economics', resolves: '2026-12-16', listed: '2026-03-18', yes: 0.64 })] },
  { provider: 'ks', eventId: 'ks-ev-fed-dec', eventTitle: 'Fed decision at Dec 2026 FOMC', url: 'https://kalshi.com/markets/kxfeddecision-26dec', available: true,
    markets: [m({ provider: 'ks', marketId: 'ks-fed-dec-cut', marketTitle: 'Fed cuts rates at Dec 2026 FOMC', settlementGroup: 'fed', category: 'Economics', resolves: '2026-12-16', listed: '2026-03-18', yes: 0.64 })] },
  { provider: 'pm', eventId: 'pm-ev-shutdown', eventTitle: 'Government shutdown before Feb 1', url: 'https://polymarket.com/event/government-shutdown-before-feb-1', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-shutdown-feb1', marketTitle: 'Government shutdown before Feb 1', settlementGroup: 'shut', category: 'Politics', resolves: '2027-02-01', listed: '2026-09-15', yes: 0.47 })] },
  // Markets the sample portfolio doesn't hold.
  { provider: 'pm', eventId: 'pm-ev-eth5k', eventTitle: 'Ethereum above $5,000 on Dec 31', url: 'https://polymarket.com/event/ethereum-above-5000-on-december-31', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-eth-5k', marketTitle: 'Ethereum above $5,000 on Dec 31', settlementGroup: 'pm-eth-5k', category: 'Crypto', resolves: '2026-12-31', listed: '2026-01-05', yes: 0.18 })] },
  { provider: 'ks', eventId: 'ks-ev-fed-jan', eventTitle: 'Fed decision at Jan 2027 FOMC', url: 'https://kalshi.com/markets/kxfeddecision-27jan', available: true,
    markets: [
      m({ provider: 'ks', marketId: 'ks-fedjan-cut', marketTitle: 'Fed cuts rates at Jan 2027 FOMC', settlementGroup: 'ks-fedjan-cut', category: 'Economics', resolves: '2027-01-27', listed: '2026-05-01', yes: 0.31 }),
      m({ provider: 'ks', marketId: 'ks-fedjan-hold', marketTitle: 'Fed holds rates at Jan 2027 FOMC', settlementGroup: 'ks-fedjan-hold', category: 'Economics', resolves: '2027-01-27', listed: '2026-05-01', yes: 0.66 }),
    ] },
  { provider: 'pm', eventId: 'pm-ev-gdp', eventTitle: 'US Q4 GDP growth above 2%', url: 'https://polymarket.com/event/us-q4-gdp-growth-above-2', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-gdp-q4', marketTitle: 'US Q4 GDP growth above 2%', settlementGroup: 'pm-gdp-q4', category: 'Economics', resolves: '2027-01-29', listed: '2026-07-01', yes: 0.55 })] },
  { provider: 'ks', eventId: 'ks-ev-nyc-temp', eventTitle: 'NYC January warmer than average', url: 'https://kalshi.com/markets/kxnyctemp-27jan', available: true,
    markets: [m({ provider: 'ks', marketId: 'ks-nyc-jan-warm', marketTitle: 'NYC January 2027 warmer than average', settlementGroup: 'ks-nyc-jan-warm', category: 'Climate', resolves: '2027-02-02', listed: '2026-10-01', yes: 0.48 })] },
  { provider: 'pm', eventId: 'pm-ev-lakers', eventTitle: '2027 NBA Champion: Lakers', url: 'https://polymarket.com/event/lakers-win-2027-nba-finals', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-lakers-2027', marketTitle: 'Lakers win 2027 Finals', settlementGroup: 'pm-lakers-2027', category: 'Sports', resolves: '2027-06-20', listed: '2026-07-01', yes: 0.07 })] },
  { provider: 'ks', eventId: 'ks-ev-oil', eventTitle: 'WTI oil above $90 on Dec 31', url: 'https://kalshi.com/markets/kxwti-26dec31', available: true,
    markets: [m({ provider: 'ks', marketId: 'ks-wti-90', marketTitle: 'WTI oil above $90 on Dec 31', settlementGroup: 'ks-wti-90', category: 'Economics', resolves: '2026-12-31', listed: '2026-02-02', yes: null })] },
  { provider: 'pm', eventId: 'pm-ev-sol', eventTitle: 'Solana above $500 on Dec 31', url: 'https://polymarket.com/event/solana-above-500-on-december-31', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-sol-500', marketTitle: 'Solana above $500 on Dec 31', settlementGroup: 'pm-sol-500', category: 'Crypto', resolves: '2026-12-31', listed: '2026-01-05', yes: 0.12 })] },
  { provider: 'ks', eventId: 'ks-ev-unemp', eventTitle: 'US unemployment above 4.5% in January', url: 'https://kalshi.com/markets/kxunemp-27jan', available: true,
    markets: [m({ provider: 'ks', marketId: 'ks-unemp-45', marketTitle: 'US unemployment above 4.5% in January', settlementGroup: 'ks-unemp-45', category: 'Economics', resolves: '2027-02-05', listed: '2026-08-03', yes: 0.22, fee: null })] },
  { provider: 'pm', eventId: 'pm-ev-mayor', eventTitle: 'Springfield mayoral election', url: 'https://polymarket.com/event/springfield-mayoral-election', available: true,
    markets: [m({ provider: 'pm', marketId: 'pm-mayor', marketTitle: 'Incumbent wins Springfield mayoral election', settlementGroup: 'pm-mayor', category: 'Politics', resolves: '2026-11-05', listed: '2026-02-10', closes: '2026-11-04', yes: 0.99, status: 'resolved', election: true, resolution: { outcome: 'YES', at: '2026-11-05' } })] },
  // A known link whose market data is unavailable (e.g. delisted), to exercise that state.
  { provider: 'ks', eventId: 'ks-ev-delisted', eventTitle: 'Delisted market', url: 'https://kalshi.com/markets/kxdelisted-26', available: false, markets: [] },
]

export const SAMPLE_MARKET_CATALOG = fixtureCatalog(SAMPLE_MARKET_EVENTS, 'Sample market data')
