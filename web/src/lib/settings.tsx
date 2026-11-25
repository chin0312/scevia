/* User preferences. Kept in this browser tab like the rest of Scevia's state (lib/storage.ts, `scevia-` key).
   Every preference here changes something real: default views, which alerts appear, and the Risk guardrail.
   Nothing here changes data or calculations. */
import { createContext, useContext, type ReactNode } from 'react'
import { PERIODS, type Period, type PlatformFilter } from './finance'
import { readStored } from './storage'
import { useSessionState } from './useSessionState'

export interface Settings {
  /** Platform scope Overview opens in. */
  defaultScope: PlatformFilter
  /** Period Overview and Analytics open in. */
  defaultPeriod: Period
  /** How Scenario Lab positions are sized when a session starts. */
  labSize: 'shares' | 'amount' | 'weight'
  /** Single-event concentration guardrail (% of committed capital). Flags only; never trades. */
  guardrail: number
  alerts: {
    /** Alert for positions resolving within this many days (0 = off). */
    resolvingWithin: number
    /** Alert for the largest mark move since the last visit when it exceeds this many dollars (0 = off). */
    priceMove: number
    /** Alert when settlements carry estimated fees. */
    feeEstimates: boolean
  }
}
export const DEFAULT_SETTINGS: Settings = { defaultScope: 'all', defaultPeriod: '6M', labSize: 'shares', guardrail: 15, alerts: { resolvingWithin: 30, priceMove: 100, feeEstimates: true } }
export const GUARDRAIL_RANGE = [5, 40] as const

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d)
/** Validate stored settings field by field; anything malformed falls back to its default. */
export function readSettings(raw: unknown): Settings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const a = o.alerts && typeof o.alerts === 'object' ? (o.alerts as Record<string, unknown>) : {}
  // The guardrail used to be stored on its own; keep the user's value.
  const legacy = readStored<number | null>('scevia-guardrail', null, (v) => (typeof v === 'number' ? v : null))
  const D = DEFAULT_SETTINGS
  return {
    defaultScope: o.defaultScope === 'pm' || o.defaultScope === 'ks' ? o.defaultScope : 'all',
    defaultPeriod: PERIODS.includes(o.defaultPeriod as Period) ? (o.defaultPeriod as Period) : D.defaultPeriod,
    labSize: o.labSize === 'amount' || o.labSize === 'weight' ? o.labSize : 'shares',
    guardrail: num(o.guardrail, GUARDRAIL_RANGE[0], GUARDRAIL_RANGE[1], num(legacy, GUARDRAIL_RANGE[0], GUARDRAIL_RANGE[1], D.guardrail)),
    alerts: {
      resolvingWithin: num(a.resolvingWithin, 0, 365, D.alerts.resolvingWithin),
      priceMove: num(a.priceMove, 0, 1_000_000, D.alerts.priceMove),
      feeEstimates: typeof a.feeEstimates === 'boolean' ? a.feeEstimates : D.alerts.feeEstimates,
    },
  }
}

export type SettingsTab = 'General' | 'Alerts' | 'Risk' | 'Data & privacy'
interface Ctx { settings: Settings; update: (patch: Partial<Settings>) => void; open: (tab?: SettingsTab) => void }
const SettingsCtx = createContext<Ctx>({ settings: DEFAULT_SETTINGS, update: () => {}, open: () => {} })
export const useSettings = () => useContext(SettingsCtx)

export function SettingsProvider({ children, onOpen }: { children: ReactNode; onOpen: (tab: SettingsTab) => void }) {
  const [settings, set] = useSessionState<Settings>('scevia-settings', readSettings(null), (raw) => readSettings(raw))
  const update = (patch: Partial<Settings>) => set((s) => ({ ...s, ...patch, alerts: { ...s.alerts, ...(patch.alerts ?? {}) } }))
  return <SettingsCtx.Provider value={{ settings, update, open: (tab = 'General') => onOpen(tab) }}>{children}</SettingsCtx.Provider>
}
