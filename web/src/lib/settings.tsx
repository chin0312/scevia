/* Workspace preferences: how Scevia displays and analyzes portfolio information. Kept in this browser tab
   (lib/storage.ts, `scevia-settings`). Every preference here changes something real; none changes data, a saved
   scenario's assumptions, or a calculation's definition. Personal identity and privacy live in the account menu. */
import { createContext, useContext, type ReactNode } from 'react'
import { PERIODS, type Period, type PlatformFilter } from './finance'
import { readStored } from './storage'
import { isReportingCurrency, readFxPreferences, type FxPreferences, type ReportingCurrency } from './fx'
import { useSessionState } from './useSessionState'

export interface Settings {
  /** Platform scope Overview opens in. */
  defaultScope: PlatformFilter
  /** Currency all portfolio money is reported in (converted at the latest eligible reference; never transferred). */
  reportingCurrency: ReportingCurrency
  /** Preferred reference sources (advanced). 'auto' selects among eligible evidence (the default). */
  fx: FxPreferences
  /** Check the selected portfolio's sources every N minutes while Scevia is open (0 = only on request). */
  autoRefresh: 0 | 5 | 15 | 60
  /** How market prices of standard binary contracts are shown: $0.64 or 64% (market-implied). */
  priceDisplay: 'price' | 'implied'
  /** Fee assumption new scenarios and replays start with. Saved ones keep their own. */
  newFees: 'provider' | 'excluded'
  /** Period Overview's chart and Analytics open in. */
  defaultPeriod: Period
  /** Grouping Overview's allocation and Analytics' attribution open in. */
  defaultGrouping: 'category' | 'platform'
  /** How Scenario Lab shows position targets when it opens (each scenario keeps the unit each target was typed in). */
  labSize: 'shares' | 'amount' | 'weight'
  /** Single-event concentration guardrail: % of committed capital (cost basis of open positions). Flags only. */
  guardrail: number
  alerts: {
    /** Upcoming scheduled resolutions within this many days (0 = off). */
    resolvingWithin: number
    /** Position value moves since the last visit of at least this many dollars (0 = off). */
    priceMove: number
    /** Events above the concentration guardrail. */
    concentration: boolean
    /** Recently settled trades. */
    settlements: boolean
    /** Estimated fees, stale sources and records needing review. */
    dataQuality: boolean
    /** Local import and reconciliation activity. */
    imports: boolean
  }
}
export const DEFAULT_SETTINGS: Settings = {
  defaultScope: 'all', reportingCurrency: 'USD', fx: { fiatSource: 'auto', stablecoinSource: 'auto' }, autoRefresh: 15, priceDisplay: 'price', newFees: 'provider', defaultPeriod: '6M', defaultGrouping: 'category', labSize: 'shares', guardrail: 15,
  alerts: { resolvingWithin: 30, priceMove: 100, concentration: true, settlements: true, dataQuality: true, imports: true },
}
export const GUARDRAIL_RANGE = [5, 40] as const
/** Settings sections, each with its own Restore defaults. */
export const SECTION_FIELDS = {
  General: ['reportingCurrency', 'fx', 'defaultScope', 'autoRefresh', 'priceDisplay'], Analytics: ['defaultPeriod', 'defaultGrouping'], Risk: ['guardrail'], 'Scenario Lab': ['labSize', 'newFees'], Notifications: ['alerts'],
} as const satisfies Record<string, readonly (keyof Settings)[]>
export type SettingsTab = keyof typeof SECTION_FIELDS

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
/** Validate stored settings field by field; anything malformed falls back to its default. */
export function readSettings(raw: unknown): Settings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const a = o.alerts && typeof o.alerts === 'object' ? (o.alerts as Record<string, unknown>) : {}
  const legacy = readStored<number | null>('scevia-guardrail', null, (v) => (typeof v === 'number' ? v : null))
  const D = DEFAULT_SETTINGS, DA = D.alerts
  return {
    defaultScope: o.defaultScope === 'pm' || o.defaultScope === 'ks' ? o.defaultScope : 'all',
    // Earlier prototypes offered SGD and MYR; any value that isn't selectable now returns to USD (a display preference
    // only; no stored amount or saved result changes).
    reportingCurrency: isReportingCurrency(o.reportingCurrency) ? o.reportingCurrency : 'USD',
    fx: readFxPreferences(o.fx),
    autoRefresh: o.autoRefresh === 0 || o.autoRefresh === 5 || o.autoRefresh === 60 ? o.autoRefresh : D.autoRefresh,
    priceDisplay: o.priceDisplay === 'implied' ? 'implied' : 'price',
    newFees: o.newFees === 'excluded' ? 'excluded' : 'provider',
    defaultPeriod: PERIODS.includes(o.defaultPeriod as Period) ? (o.defaultPeriod as Period) : D.defaultPeriod,
    defaultGrouping: o.defaultGrouping === 'platform' ? 'platform' : 'category',
    labSize: o.labSize === 'amount' || o.labSize === 'weight' ? o.labSize : 'shares',
    guardrail: num(o.guardrail, GUARDRAIL_RANGE[0], GUARDRAIL_RANGE[1], num(legacy, GUARDRAIL_RANGE[0], GUARDRAIL_RANGE[1], D.guardrail)),
    alerts: {
      resolvingWithin: num(a.resolvingWithin, 0, 365, DA.resolvingWithin), priceMove: num(a.priceMove, 0, 1_000_000, DA.priceMove),
      concentration: bool(a.concentration, DA.concentration), settlements: bool(a.settlements, DA.settlements),
      dataQuality: bool(a.dataQuality ?? a.feeEstimates, DA.dataQuality), imports: bool(a.imports, DA.imports),
    },
  }
}
/** Defaults for one section only; other sections are untouched. */
export function resetSection(s: Settings, tab: SettingsTab): Settings {
  const out = { ...s, alerts: { ...s.alerts } } as Record<string, unknown>
  for (const k of SECTION_FIELDS[tab]) out[k] = k === 'alerts' ? { ...DEFAULT_SETTINGS.alerts } : DEFAULT_SETTINGS[k]
  return out as unknown as Settings
}

interface Ctx { settings: Settings; update: (patch: Partial<Settings>) => void; replace: (s: Settings) => void; open: (tab?: SettingsTab) => void }
const SettingsCtx = createContext<Ctx>({ settings: DEFAULT_SETTINGS, update: () => {}, replace: () => {}, open: () => {} })
export const useSettings = () => useContext(SettingsCtx)

export function SettingsProvider({ children, onOpen }: { children: ReactNode; onOpen: (tab: SettingsTab) => void }) {
  const [settings, set] = useSessionState<Settings>('scevia-settings', readSettings(null), (raw) => readSettings(raw))
  const update = (patch: Partial<Settings>) => set((s) => ({ ...s, ...patch, alerts: { ...s.alerts, ...(patch.alerts ?? {}) } }))
  return <SettingsCtx.Provider value={{ settings, update, replace: set, open: (tab = 'General') => onOpen(tab) }}>{children}</SettingsCtx.Provider>
}
