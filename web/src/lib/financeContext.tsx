/* The selected workspace's read model. `useFinance()` returns calculations bound to that workspace's portfolio data
   (never a global portfolio). A workspace without figures (loading, unavailable, failed, or a Demo/own portfolio not
   connected yet) gets an empty portfolio with `hasPortfolio: false`, so Scenario Lab can still build from scratch and
   replay history with virtual capital, and no other portfolio's figures can appear. */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { PortfolioData } from '../data/types'
import { createFinance, type Finance } from './finance'

export const emptyPortfolio = (asOf: string): PortfolioData => ({
  asOf, historyStart: asOf, lastVisit: asOf, isSample: false, accounts: [], cashFlows: [], openPositions: [], closedTrades: [], events: [], relations: [], sources: {},
})
export interface FinanceCtx { F: Finance; hasPortfolio: boolean; workspaceId: string }
const Ctx = createContext<FinanceCtx | null>(null)

export function FinanceProvider({ data, workspaceId, revision, children }: { data: PortfolioData | null; workspaceId: string; revision: string | null; children: ReactNode }) {
  // Recomputed only when the workspace or its revisions change; a refresh without new data keeps the same instance.
  const value = useMemo<FinanceCtx>(() => ({ F: createFinance(data ?? emptyPortfolio(new Date().toISOString().slice(0, 10))), hasPortfolio: !!data, workspaceId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, revision, data])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export function useFinanceCtx(): FinanceCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useFinance() needs a FinanceProvider (the selected workspace)')
  return c
}
export const useFinance = () => useFinanceCtx().F
