/* The market-discovery service for Scenario Lab (search, links, native ids, evidence). Provided by the app so the
   bundled sample catalog can be replaced by the backend market service (PR #9 market demand, Phase 8 historical
   evidence) without changing the pages. Components never call providers directly. */
import { createContext, useContext, type ReactNode } from 'react'
import { MARKET_CATALOG } from '../data/markets'
import type { MarketCatalog } from './markets'

const Ctx = createContext<MarketCatalog>(MARKET_CATALOG)
export function MarketCatalogProvider({ catalog, children }: { catalog?: MarketCatalog; children: ReactNode }) {
  return <Ctx.Provider value={catalog ?? MARKET_CATALOG}>{children}</Ctx.Provider>
}
export const useMarketCatalog = () => useContext(Ctx)
