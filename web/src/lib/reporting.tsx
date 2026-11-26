/* Reporting currency for the whole app. The selected currency (Settings › General) and the exchange-rate service's
   latest eligible reference set how portfolio money is shown everywhere (lib/format.ts). Conversion is presentation:
   no stored amount, native balance, quantity or funding changes. The bundled service is the labelled development
   fixture; the backend supplies references (current, per historical date, per scenario evaluation) at integration. */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { AUTO_FX, currencyInfo, fixtureFx, type FxPreferences, type FxReference, type FxService, type ReportingCurrency } from './fx'
import { setReportingFormat } from './format'

interface Ctx { currency: ReportingCurrency; fx: FxService; reference: FxReference; toReporting: (amount: number | null, asset: string) => number | null; assetReference: (asset: string) => FxReference }
const ReportingCtx = createContext<Ctx | null>(null)
const DEFAULT_FX = fixtureFx()

export function ReportingProvider({ currency, prefs = AUTO_FX, fx: given, children }: { currency: ReportingCurrency; prefs?: FxPreferences; fx?: FxService; children: ReactNode }) {
  const fx = useMemo(() => given ?? fixtureFx(undefined, prefs), [given, prefs])
  const value = useMemo<Ctx>(() => {
    const reference = fx.reference('USD', currency)
    const assetReference = (asset: string) => fx.reference(asset, currency)
    return {
      currency, fx, reference, assetReference,
      toReporting: (amount, asset) => { if (amount === 0) return 0; const r = assetReference(asset); return amount == null || r.rate == null ? null : amount * r.rate },
    }
  }, [currency, fx])
  // Set before any page renders (the subtree is keyed by currency in the shell, so every figure re-renders).
  setReportingFormat({ code: currency, symbol: currencyInfo(currency).symbol, rate: value.reference.rate })
  return <ReportingCtx.Provider value={value}>{children}</ReportingCtx.Provider>
}

export function useReporting(): Ctx {
  const c = useContext(ReportingCtx)
  if (c) return c
  const reference = DEFAULT_FX.reference('USD', 'USD')
  return { currency: 'USD', fx: DEFAULT_FX, reference, assetReference: (a) => DEFAULT_FX.reference(a, 'USD'), toReporting: (v, a) => { const r = DEFAULT_FX.reference(a, 'USD'); return v == null || r.rate == null ? null : v * r.rate } }
}
