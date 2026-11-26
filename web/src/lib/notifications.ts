/* Notification centre model. Notifications are derived from the sample portfolio and from local workspace activity
   while Scevia is open: there is no background monitoring, email or push. Each has a stable id built from what it is
   about (an event and its scheduled date, a position and the visit window, a trade, an import batch), so re-rendering
   never creates copies and read state survives navigation and reloads. */
import type { Detail } from '../components/details'
import type { IconName } from '../components/Icon'
import { PLATFORM_NAME } from '../data/labels'
import type { Platform } from '../data/types'
import { daysBetween, fmtDate, tradeNet, type Finance } from './finance'
import { fmt, pct, sfmt } from './format'
import type { ManagedRecord } from './records'
import { statusOf } from './records'
import type { Settings } from './settings'
import type { LocalEvent } from './useWorkspace'

export type NotifCategory = 'resolutions' | 'risk' | 'activity' | 'settlement' | 'data' | 'sources' | 'imports'
export const CATEGORY_LABEL: Record<NotifCategory, string> = {
  resolutions: 'Upcoming resolutions', risk: 'Risk & concentration', activity: 'Portfolio activity', settlement: 'Settlements',
  data: 'Data quality', sources: 'Sources', imports: 'Imports & reconciliation',
}
export interface Notif {
  id: string; category: NotifCategory; title: string; body: string
  /** When the underlying event happened (or is observed, for sample-derived states). */
  at: string
  icon: IconName; tone: 'warn' | 'gain' | 'loss' | 'accent'
  /** What it is about: an event, a position, an account or the portfolio. */
  scope: 'event' | 'position' | 'account' | 'portfolio'
  detail?: Detail; to?: string
  /** 'sample' = derived from the selected portfolio's data; 'local' = from something you did in this tab. */
  origin: 'sample' | 'local'
}

/** Notifications of one workspace, derived from that workspace's own read model (`F`) and its local events. */
export function deriveNotifications(F: Finance, s: Settings, records: ManagedRecord[], local: LocalEvent[], batchIds?: Set<string>): Notif[] {
  const { POSITIONS, account, exposures, sourceOf, CLOSED_TRADES, LAST_VISIT, TODAY } = F
  const out: Notif[] = [], A = s.alerts
  const exps = exposures('all'), total = exps.reduce((a, e) => a + e.cost, 0)
  // One alert per event (not per contract): the same Fed decision on two venues is one resolution.
  if (A.resolvingWithin > 0) for (const e of exps.filter((x) => x.days >= 0 && x.days <= A.resolvingWithin))
    out.push({ id: `resolve:${e.event.id}:${e.resolves}`, category: 'resolutions', title: `${e.event.name} is scheduled to resolve in ${e.days} days`, body: `${fmt(e.cost)} committed on ${e.platforms.map((p) => PLATFORM_NAME[p]).join(' and ')}. Scheduled for ${fmtDate(e.resolves)}`, at: `${TODAY}T08:00:00Z`, icon: 'cal', tone: 'warn', scope: 'event', detail: { kind: 'event', id: e.event.id }, origin: 'sample' })
  if (A.concentration && total > 0) for (const e of exps.filter((x) => (x.cost / total) * 100 > s.guardrail))
    out.push({ id: `conc:${e.event.id}:${s.guardrail}`, category: 'risk', title: `${e.event.name} is above your ${s.guardrail}% limit`, body: `${pct((e.cost / total) * 100, 1)} of committed capital`, at: `${TODAY}T08:00:00Z`, icon: 'shield', tone: 'warn', scope: 'event', detail: { kind: 'event', id: e.event.id }, origin: 'sample' })
  if (A.priceMove > 0) for (const p of POSITIONS) {
    const moved = (p.mark - p.markAtLastVisit) * p.shares
    if (Math.abs(moved) >= A.priceMove) out.push({ id: `move:${p.id}:${LAST_VISIT}`, category: 'activity', title: `${p.market} ${p.side}: ${p.markAtLastVisit.toFixed(2)} → ${p.mark.toFixed(2)}`, body: `${sfmt(moved)} position value since ${fmtDate(LAST_VISIT)}`, at: `${TODAY}T08:00:00Z`, icon: 'trend', tone: moved >= 0 ? 'gain' : 'loss', scope: 'position', detail: { kind: 'position', id: p.id }, origin: 'sample' })
  }
  if (A.settlements) for (const t of CLOSED_TRADES.filter((x) => x.outcome !== 'Closed early' && daysBetween(x.closed, TODAY) <= 7 && x.closed <= TODAY))
    out.push({ id: `settle:${t.id}`, category: 'settlement', title: `${t.market} settled and ${t.outcome === 'Won' ? 'won' : 'lost'}`, body: `${sfmt(tradeNet(t), 2)} after fees on ${PLATFORM_NAME[t.platform]}`, at: `${t.closed}T12:00:00Z`, icon: 'check', tone: tradeNet(t) >= 0 ? 'gain' : 'loss', scope: 'position', to: '/analytics', origin: 'sample' })
  if (A.dataQuality) {
    const est = account().feeEstimates
    if (est) out.push({ id: `fees:estimated:${est}`, category: 'data', title: `${est} settlements use estimated fees`, body: 'Kalshi didn’t report these fees, so net P&L uses estimates', at: `${TODAY}T08:00:00Z`, icon: 'alert', tone: 'warn', scope: 'account', to: '/portfolio/coverage', origin: 'sample' })
    for (const p of ['pm', 'ks'] as Platform[]) { const src = sourceOf(p); if (src.stale) out.push({ id: `stale:${p}:${src.asOf}`, category: 'sources', title: `${PLATFORM_NAME[p]} data is from ${fmtDate(src.asOf)}`, body: 'The latest data is more than a day old. Figures use it as is', at: `${src.asOf}T18:00:00Z`, icon: 'clock', tone: 'warn', scope: 'account', to: '/portfolio/coverage', origin: 'sample' }) }
    const review = records.filter((r) => statusOf(r, records) === 'review').length
    if (review) out.push({ id: `review:${review}:${records.length}`, category: 'imports', title: `${review} record${review === 1 ? ' needs' : 's need'} review`, body: 'They don’t count until you decide', at: `${TODAY}T08:00:00Z`, icon: 'list', tone: 'warn', scope: 'account', to: '/portfolio/transactions?status=review', origin: 'local' })
  }
  // Local import activity is shown only while its batch still exists (an undone import takes its event with it).
  if (A.imports) for (const e of local.filter((x) => !x.batchId || !batchIds || batchIds.has(x.batchId))) out.push({ id: e.id, category: 'imports', title: e.title, body: e.body, at: e.at, icon: 'download', tone: 'accent', scope: 'account', to: e.to, origin: 'local' })
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}
