/* Historical Replay (inside Scenario Lab): a retrospective hypothetical portfolio over a past period.
   Build (period, virtual funding, markets with entry/exit and explicit execution prices) → Analyze (exact results for
   the stated assumptions, funding status, evidence coverage) → Compare (replays on a common basis).
   It needs no portfolio or connected account: capital is virtual, per venue and native asset, and freely editable.
   It is hindsight analysis, labelled as such. It never claims a strategy was executable, never values a holding without
   a recorded price, never counts an unknown fee as zero and never touches actual records. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { LineChart } from '../components/charts'
import { Icon } from '../components/Icon'
import { Menu, Modal, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, PlatformBadge, Seg, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import { MARKET_CATALOG } from '../data/markets'
import type { Denomination, Platform } from '../data/types'
import { addDays, fmtDate, type Outcome } from '../lib/finance'
import { useFinanceCtx } from '../lib/financeContext'
import { feeLabel } from '../lib/fees'
import { fmtNative, kfmt, pct, qty } from '../lib/format'
import { BASIS_LABEL } from '../lib/history'
import type { CatalogEvent } from '../lib/markets'
import {
  DEFAULT_ASSET, MAX_REPLAY_POSITIONS, bucketId, compareReplays, coverShortfall, replayMarketFrom, replayValid, runReplay, sanitizeReplays, tradingWindow, validateReplay,
  type FundingBucket, type FundingStatus, type Replay, type ReplayPosition, type ReplayResult,
} from '../lib/replay'
import { useSettings } from '../lib/settings'
import { scopedKey } from '../lib/storage'
import { useSessionState } from '../lib/useSessionState'
import { useActiveWorkspace } from '../lib/workspaceContext'
import { COLORS } from './lab/model'

export const REPLAYS_KEY = 'scevia-replays-v1'
type View = 'Build' | 'Analyze' | 'Compare'
const VIEWS = ['Build', 'Analyze', 'Compare'] as const
const RAILS: Record<View, RailSection[]> = {
  Build: [{ id: 'rp-setup', label: 'Period & funding', icon: 'cal' }, { id: 'rp-positions', label: 'Positions', icon: 'list' }],
  Analyze: [{ id: 'rp-results', label: 'Results', icon: 'spark' }, { id: 'rp-value', label: 'Value over time', icon: 'trend' }, { id: 'rp-lines', label: 'Positions', icon: 'table' }, { id: 'rp-cash', label: 'Cash flows', icon: 'db' }, { id: 'rp-evidence', label: 'Evidence', icon: 'shield' }],
  Compare: [{ id: 'rp-compare', label: 'Comparison', icon: 'compare' }],
}
const ASSETS: Record<Platform, Denomination[]> = { pm: ['USDC', 'PUSD'], ks: ['USD'] }
const long = (d: string) => fmtDate(d.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })
const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const sNative = (v: number, d: string, dp = 2) => `${v > 0 ? '+' : ''}${fmtNative(v, d, dp)}`
const bucketLabel = (b: Pick<FundingBucket, 'venue' | 'denomination'>) => `${PLATFORM_NAME[b.venue]} · ${b.denomination}`
const FUNDING_LABEL: Record<FundingStatus, string> = { funded: 'Funded', unfunded: 'Unfunded what-if', unavailable: 'Funding unknown' }

export default function ReplayPage() {
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { settings } = useSettings()
  const { F, workspaceId } = useFinanceCtx()
  const ws = useActiveWorkspace().snapshot
  const today = F.TODAY
  const [replays, setReplays] = useSessionState<Replay[]>(scopedKey(REPLAYS_KEY, workspaceId), [], sanitizeReplays)
  const [view, setView] = useSessionState<View>('scevia-replay-view', 'Build', (v) => (VIEWS.includes(v as View) ? (v as View) : null))
  const [activeKey, setActiveKey] = useState<string | null>(() => params.get('open'))
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const create = () => {
    const key = `r${Date.now().toString(36)}`
    const r: Replay = { key, name: `Historical replay ${replays.length + 1}`, color: COLORS[replays.length % COLORS.length], start: addDays(today, -182), end: today, buckets: [], fees: settings.newFees === 'excluded' ? { mode: 'excluded' } : { mode: 'provider', role: 'taker' }, rates: { USDC: null, PUSD: null }, positions: [], basis: 'retrospective', createdAt: today }
    setReplays((rs) => [...rs, r]); setActiveKey(key); setView('Build')
  }
  // ?new=1 creates once; ?open=key selects. Both are cleared so reloads and Back don't repeat them.
  const handled = useRef(false)
  useEffect(() => {
    if (handled.current) return
    handled.current = true
    if (params.get('new') === '1') { create(); setParams({}, { replace: true }) }
    else if (params.get('open')) setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const active = replays.find((r) => r.key === activeKey) ?? replays.at(-1) ?? null
  const update = (fn: (r: Replay) => Replay) => active && setReplays((rs) => rs.map((r) => (r.key === active.key ? fn(r) : r)))
  const issues = active ? validateReplay(active, today) : null
  const valid = !!issues && replayValid(issues) && active!.positions.length > 0
  const result = useMemo(() => (active && valid ? runReplay(active, today) : null), [active, valid, today])
  const issueCount = issues ? (issues.period ? 1 : 0) + (issues.capital ? 1 : 0) + Object.keys(issues.positions).length : 0

  if (!active) return (
    <div className="shell">
      <SectionRail title="Historical Replay" sections={[{ id: 'rp-start', label: 'Start', icon: 'clock' }]} />
      <main className="lab-main">
        <section className="page-head anchor" id="rp-start"><div><div className="caps"><span className="accent">Scenario Lab</span> · Historical Replay · hindsight analysis</div><h1>Replay a portfolio over a past period</h1></div></section>
        <Card><div className="card-b" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <p className="t2">Choose a past period, virtual starting capital and markets that traded then. No account or real funds are needed. Scevia applies the execution prices and fees you state, settles positions at their recorded resolution and values open holdings from recorded prices.</p>
          <div className="row" style={{ gap: 'var(--space-2)' }}><Button variant="primary" icon="clock" onClick={create}>Start a historical replay</Button><Link className="link" to="/scenario-lab">Back to Scenario Lab</Link></div>
        </div></Card>
      </main>
    </div>
  )

  return (
    <div className="shell">
      <SectionRail title="Historical Replay" sections={RAILS[view]}>
        <div className="rail-keep">
          <h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Replays</h6>
          <div className="scn" role="listbox" aria-label="Replays">
            {replays.map((r) => (
              <a key={r.key} href="#summary" role="option" aria-selected={r.key === active.key} className={cx(r.key === active.key && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey(r.key) }}>
                <i style={{ background: r.color }} /><span className="scn-n">{r.name}</span><small>{fmtDate(r.start)}–{fmtDate(r.end)}</small>
              </a>
            ))}
          </div>
          <Link className="link" to="/scenario-lab" style={{ display: 'inline-block', fontSize: 'var(--font-size-xs)', margin: 'var(--space-3) 0 0 var(--space-3)' }}>← Scenario Lab</Link>
        </div>
      </SectionRail>
      <main className="lab-main">
        <section className="page-head anchor lab-head" id="summary">
          <div style={{ minWidth: 0 }}>
            <div className="caps"><span className="accent">Scenario Lab</span> · Historical Replay · hindsight analysis · kept in this tab</div>
            {renaming
              ? <input className="inline-edit" aria-label="Replay name" autoFocus defaultValue={active.name} onBlur={(e) => { const v = e.target.value.trim(); if (v) update((r) => ({ ...r, name: v.slice(0, 80) })); setRenaming(false) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }} />
              : <h1 className="scn-title">{active.name}<button type="button" className="edit-btn" aria-label="Rename replay" onClick={() => setRenaming(true)}><Icon name="edit" size={16} /></button></h1>}
          </div>
          <div className="actions">
            <Button icon="plus" onClick={create}>New replay</Button>
            <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>
            <Button icon="copy" onClick={() => { const key = `r${Date.now().toString(36)}`; setReplays((rs) => [...rs, { ...active, key, name: `${active.name} (copy)`.slice(0, 80), color: COLORS[rs.length % COLORS.length], buckets: active.buckets.map((b) => ({ ...b })), positions: active.positions.map((p) => ({ ...p })) }]); setActiveKey(key); toast('Replay duplicated') }}>Duplicate</Button>
          </div>
        </section>
        <div className="lab-nav">
          <Tabs label="Replay views" options={VIEWS} value={view} onChange={(v) => { setView(v); window.scrollTo(0, 0) }}
            render={(o) => <span className="row" style={{ gap: 'var(--space-2)' }}>{o}{o === 'Build' && issueCount > 0 && <span className="tab-flag" aria-label={`${issueCount} to fix`}>{issueCount}</span>}{o === 'Compare' && <small className="t3">{replays.length}</small>}</span>} />
          <div className="assume-bar" role="group" aria-label="Replay assumptions">
            <span><span className="t3">Period</span> {long(active.start)} – {long(active.end)}</span>
            <span><span className="t3">Funding</span> virtual{active.buckets.length ? `, ${active.buckets.length} bucket${active.buckets.length === 1 ? '' : 's'}` : ''}</span>
            <span><span className="t3">Fees</span> {feeLabel(active.fees).toLowerCase()}</span>
            <span><span className="t3">Prices</span> your execution assumptions</span>
            <span><span className="t3">Selection</span> with hindsight</span>
          </div>
        </div>

        {view === 'Build' && <BuildReplay r={active} issues={issues!} result={result} onChange={update} onAdd={() => setAdding(true)} onAnalyze={() => { setView('Analyze'); window.scrollTo(0, 0) }} valid={valid} />}
        {view === 'Analyze' && (result ? <AnalyzeReplay res={result} onChange={update} /> : <Callout tone="warn" icon="alert">This replay can’t be analyzed yet: {active.positions.length === 0 ? 'add at least one position.' : `${issueCount} input${issueCount === 1 ? '' : 's'} in Build need${issueCount === 1 ? 's' : ''} attention.`} <button type="button" className="link" onClick={() => setView('Build')}>Go to Build</button></Callout>)}
        {view === 'Compare' && <CompareReplays replays={replays} today={today} activeKey={active.key} />}
        <div className="footer-note"><span>Historical replays apply your stated prices and fees to recorded market history, with hindsight. They aren’t your actual performance, a strategy test or a recommendation.</span><span>{ws.summary.name} · virtual funding · sample market data</span></div>
      </main>

      {adding && <AddReplayMarkets r={active} onClose={() => setAdding(false)} onAdd={(ps, buckets) => { update((r) => ({ ...r, buckets: [...r.buckets, ...buckets.filter((b) => !r.buckets.some((x) => x.id === b.id))], positions: [...r.positions, ...ps].slice(0, MAX_REPLAY_POSITIONS) })); setAdding(false); toast(`${ps.length} position${ps.length === 1 ? '' : 's'} added`) }} />}
      {confirmDelete && (
        <Modal title="Delete this replay?" sub={active.name} onClose={() => setConfirmDelete(false)}
          footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="primary" onClick={() => { setReplays((rs) => rs.filter((r) => r.key !== active.key)); setActiveKey(null); setConfirmDelete(false); toast('Replay deleted') }}>Delete replay</Button></>}>
          <p className="t2">It’s removed from this browser tab. Other replays and scenarios aren’t affected.</p>
        </Modal>
      )}
    </div>
  )
}

/* ───────────── Build ───────────── */
function FundingCard({ r, issues, result, onChange }: { r: Replay; issues: ReturnType<typeof validateReplay>; result: ReplayResult | null; onChange: (fn: (r: Replay) => Replay) => void }) {
  const addBucket = (venue: Platform, d: Denomination) => onChange((x) => (x.buckets.some((b) => b.id === bucketId(venue, d)) ? x : { ...x, buckets: [...x.buckets, { id: bucketId(venue, d), venue, denomination: d, capital: 0 }] }))
  const missing = (['pm', 'ks'] as Platform[]).flatMap((v) => ASSETS[v].map((d) => ({ venue: v, d }))).filter(({ venue, d }) => !r.buckets.some((b) => b.id === bucketId(venue, d)))
  return (
    <Card id="rp-setup">
      <CardHeader title="Period & virtual funding" sub="Simulated starting capital per venue and native asset. No account or deposit is needed; funds never move between buckets." />
      <div className="card-b" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="rp-period">
          <label>Start<input className="rp-in date" type="date" max={r.end} value={r.start} aria-invalid={!!issues.period} onChange={(e) => onChange((x) => ({ ...x, start: e.target.value }))} /></label>
          <label>End<input className="rp-in date" type="date" value={r.end} aria-invalid={!!issues.period} onChange={(e) => onChange((x) => ({ ...x, end: e.target.value }))} /></label>
          <div className="rp-field">Fees<Seg label="Fee assumption" options={['Provider estimate', 'Excluded'] as const} value={r.fees.mode === 'excluded' ? 'Excluded' : 'Provider estimate'} onChange={(v) => onChange((x) => ({ ...x, fees: v === 'Excluded' ? { mode: 'excluded' } : { mode: 'provider', role: 'taker' } }))} /></div>
        </div>
        {issues.period && <small className="rp-err" role="alert">{issues.period}</small>}
        <div className="rp-buckets" role="group" aria-label="Virtual funding">
          {r.buckets.length === 0 && <p className="t3">No virtual funding yet. Adding a market offers funding for its venue, or add it here.</p>}
          {r.buckets.map((b) => {
            const used = r.positions.some((p) => p.bucketId === b.id), res = result?.buckets.find((x) => x.bucket.id === b.id)
            return (
              <div key={b.id} className="rp-bucket">
                <span className="row"><PlatformBadge p={b.venue} size={16} /><b>{bucketLabel(b)}</b></span>
                <label className="rp-field">Starting capital<input className="rp-in num" inputMode="decimal" type="number" min={0} step="any" placeholder="0" aria-label={`Starting capital, ${bucketLabel(b)}`} value={b.capital || ''} onChange={(e) => { const v = num(e.target.value); onChange((x) => ({ ...x, buckets: x.buckets.map((y) => (y.id === b.id ? { ...y, capital: v != null && v >= 0 ? v : 0 } : y)) })) }} /></label>
                <span className="rp-field">Simulated cash at the end<b className="tnum">{res ? (res.cashComplete ? fmtNative(res.knownCash, b.denomination) : `${fmtNative(res.knownCash, b.denomination)} known`) : '—'}</b></span>
                {res && res.shortfall > 0 && <span className="rp-short" role="status"><span className="stale">Funding shortfall {fmtNative(res.shortfall, b.denomination)}</span><Button size="sm" onClick={() => onChange((x) => coverShortfall(x, b.id, res.shortfall))}>Add {fmtNative(Math.ceil(res.shortfall), b.denomination, 0)}</Button></span>}
                {res && res.funding === 'unavailable' && <small className="t3">Remaining budget unknown: a fee before a purchase is unknown.</small>}
                <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${bucketLabel(b)}`} disabled={used} title={used ? 'Positions use this funding' : undefined} onClick={() => onChange((x) => ({ ...x, buckets: x.buckets.filter((y) => y.id !== b.id) }))} />
              </div>
            )
          })}
          {missing.length > 0 && <Menu label="Add virtual funding" align="left" width={260} trigger={(t) => <button type="button" className="link" {...t}>+ Add virtual funding</button>}>
            {(close) => missing.map(({ venue, d }) => <button key={`${venue}${d}`} type="button" role="menuitem" className="menu-i" onClick={() => { close(); addBucket(venue, d) }}><PlatformBadge p={venue} size={14} />{PLATFORM_NAME[venue]} · {d}</button>)}
          </Menu>}
        </div>
        {issues.capital && <small className="rp-err" role="alert">{issues.capital}</small>}
      </div>
    </Card>
  )
}

function BuildReplay({ r, issues, result, onChange, onAdd, onAnalyze, valid }: { r: Replay; issues: ReturnType<typeof validateReplay>; result: ReplayResult | null; onChange: (fn: (r: Replay) => Replay) => void; onAdd: () => void; onAnalyze: () => void; valid: boolean }) {
  const setPos = (id: string, patch: Partial<ReplayPosition>) => onChange((x) => ({ ...x, positions: x.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  const another = (p: ReplayPosition) => onChange((x) => (x.positions.length >= MAX_REPLAY_POSITIONS ? x : { ...x, positions: [...x.positions, { ...p, id: `rp${Date.now().toString(36)}`, entryPrice: null, size: { ...p.size, value: null }, exit: { kind: 'settle' } }] }))
  return (<>
    <p className="t3 rp-note"><Icon name="info" size={14} /> Hindsight analysis: markets are picked knowing what happened since. Results show what these exact trades would have done at the prices you assume, not that those prices were available.</p>
    <FundingCard r={r} issues={issues} result={result} onChange={onChange} />
    <Card id="rp-positions">
      <CardHeader title="Positions" sub={`${r.positions.length} of up to ${MAX_REPLAY_POSITIONS} · a market can hold several positions (YES and NO, other dates or funding)`} right={<Button icon="plus" onClick={onAdd} disabled={r.positions.length >= MAX_REPLAY_POSITIONS}>Add markets…</Button>} />
      <div className="card-b">
        {r.positions.length === 0 ? <div className="empty"><p>No positions yet. Add markets that traded during this period.</p><Button size="sm" icon="plus" onClick={onAdd}>Add markets…</Button></div> : (
          <div className="rp-rows">
            {r.positions.map((p, i) => {
              const err = issues.positions[p.id], cav = issues.caveats[p.id], m = p.market, onVenue = r.buckets.filter((b) => b.venue === m.provider)
              const n = r.positions.filter((q) => q.market.provider === m.provider && q.market.marketId === m.marketId).length
              return (
                <div key={p.id} className={cx('rp-row', err && 'invalid')} role="group" aria-label={`Position ${i + 1}: ${m.title} ${p.outcome}`}>
                  <div className="rp-row-h">
                    <div className="row" style={{ alignItems: 'flex-start', minWidth: 0 }}><PlatformBadge p={m.provider} /><div style={{ minWidth: 0 }}><b>{m.title}</b>
                      <small className="t3">{m.listedAt ? `Opened ${long(m.listedAt)}` : 'Opening unknown'} · {m.closesAt ? `trading closed ${long(m.closesAt)}` : 'trading close not recorded'} · {m.resolution ? `resolved ${m.resolution.outcome} ${long(m.resolution.at)}` : m.expectedResolution ? `expected to resolve ${long(m.expectedResolution)}` : 'resolution date unknown'}{n > 1 ? ` · ${n} positions in this market` : ''}</small></div></div>
                    <span className="row" style={{ gap: 0 }}>
                      <Button size="sm" variant="ghost" icon="copy" aria-label={`Add another position in ${m.title}`} title="Add another position in this market" onClick={() => another(p)} disabled={r.positions.length >= MAX_REPLAY_POSITIONS} />
                      <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove position ${i + 1}`} onClick={() => onChange((x) => ({ ...x, positions: x.positions.filter((q) => q.id !== p.id) }))} />
                    </span>
                  </div>
                  <div className="rp-grid">
                    <div className="rp-field">Outcome<Seg label={`Outcome for position ${i + 1}`} options={['YES', 'NO'] as const} value={p.outcome} onChange={(v: Outcome) => setPos(p.id, { outcome: v })} /></div>
                    <label className="rp-field">Virtual funding<select className="select" value={p.bucketId} onChange={(e) => setPos(p.id, { bucketId: e.target.value })}>{onVenue.map((b) => <option key={b.id} value={b.id}>{bucketLabel(b)}</option>)}</select></label>
                    <label className="rp-field">Entry date<input className="rp-in date" type="date" min={m.listedAt?.slice(0, 10) ?? undefined} max={r.end} value={p.entryDate} onChange={(e) => setPos(p.id, { entryDate: e.target.value })} /></label>
                    <label className="rp-field">Execution price<input className="rp-in num" type="number" inputMode="decimal" min={0.01} max={0.99} step={0.01} placeholder="0.01–0.99" value={p.entryPrice ?? ''} onChange={(e) => setPos(p.id, { entryPrice: num(e.target.value) })} /></label>
                    <div className="rp-field">Size by<Seg label={`Size by for position ${i + 1}`} options={['Shares', 'Amount', '% of capital'] as const} value={p.size.mode === 'shares' ? 'Shares' : p.size.mode === 'amount' ? 'Amount' : '% of capital'} onChange={(v) => setPos(p.id, { size: { mode: v === 'Shares' ? 'shares' : v === 'Amount' ? 'amount' : 'weight', value: p.size.value } })} /></div>
                    <label className="rp-field">{p.size.mode === 'shares' ? 'Shares' : p.size.mode === 'amount' ? 'Amount' : '% of funding capital'}<input className="rp-in num" type="number" inputMode="decimal" min={0} step="any" value={p.size.value ?? ''} onChange={(e) => setPos(p.id, { size: { ...p.size, value: num(e.target.value) } })} /></label>
                    <div className="rp-field">Exit<Seg label={`Exit for position ${i + 1}`} options={['Hold to settlement', 'Sell on date'] as const} value={p.exit.kind === 'settle' ? 'Hold to settlement' : 'Sell on date'} onChange={(v) => setPos(p.id, { exit: v === 'Hold to settlement' ? { kind: 'settle' } : { kind: 'date', date: r.end, price: null } })} /></div>
                    {p.exit.kind === 'date' && <>
                      <label className="rp-field">Exit date<input className="rp-in date" type="date" min={p.entryDate} max={r.end} value={p.exit.date} onChange={(e) => setPos(p.id, { exit: { kind: 'date', date: e.target.value, price: p.exit.kind === 'date' ? p.exit.price : null } })} /></label>
                      <label className="rp-field">Exit price<input className="rp-in num" type="number" inputMode="decimal" min={0.01} max={0.99} step={0.01} placeholder="0.01–0.99" value={p.exit.price ?? ''} onChange={(e) => setPos(p.id, { exit: { kind: 'date', date: p.exit.kind === 'date' ? p.exit.date : r.end, price: num(e.target.value) } })} /></label>
                    </>}
                  </div>
                  {err ? <small className="rp-err" role="alert">{err}</small> : cav ? <small className="t3">{cav}</small> : null}
                </div>
              )
            })}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-4)', gap: 'var(--space-3)' }}>
          {!valid && r.positions.length > 0 && <small className="t3">Fix the highlighted inputs to analyze.</small>}
          <Button variant="primary" icon="spark" disabled={!valid} onClick={onAnalyze}>Analyze replay</Button>
        </div>
      </div>
    </Card>
  </>)
}

/* Market picker (through the MarketCatalog interface). Markets that didn't trade in the period can't be added; a
   market already in the replay can be added again as another position. Funding for the venue is offered automatically. */
function AddReplayMarkets({ r, onClose, onAdd }: { r: Replay; onClose: () => void; onAdd: (ps: ReplayPosition[], buckets: FundingBucket[]) => void }) {
  const [events, setEvents] = useState<CatalogEvent[] | null>(null)
  const [error, setError] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => { let live = true; MARKET_CATALOG.search('').then((e) => { if (live) setEvents(e) }).catch(() => { if (live) setError(true) }); return () => { live = false } }, [])
  const rows = (events ?? []).flatMap((ev) => ev.markets.map((m) => {
    const key = `${m.provider}:${m.marketId}`, rm = replayMarketFrom(ev, m)
    const closedBefore = m.closesAt ? m.closesAt.slice(0, 10) < r.start : !!m.resolution && m.resolution.at.slice(0, 10) <= r.start
    const why = m.listedAt && m.listedAt.slice(0, 10) > r.end ? `opened ${long(m.listedAt)}, after the period`
      : closedBefore && !tradingWindow(rm, r.start).ok ? `closed ${long(m.closesAt ?? m.resolution!.at)}, before the period` : null
    const inReplay = r.positions.filter((p) => `${p.market.provider}:${p.market.marketId}` === key).length
    return { key, ev, m, why, inReplay }
  }))
  const add = () => {
    const buckets: FundingBucket[] = []
    const ps = rows.filter((x) => picked.has(x.key)).map(({ ev, m }, i) => {
      const existing = r.buckets.find((b) => b.venue === m.provider) ?? buckets.find((b) => b.venue === m.provider)
      const b = existing ?? { id: bucketId(m.provider, DEFAULT_ASSET[m.provider]), venue: m.provider, denomination: DEFAULT_ASSET[m.provider], capital: 0 }
      if (!existing) buckets.push(b)
      const entry = m.listedAt && m.listedAt.slice(0, 10) > r.start ? m.listedAt.slice(0, 10) : r.start
      return { id: `rp${Date.now().toString(36)}${i}`, market: replayMarketFrom(ev, m), outcome: 'YES' as const, bucketId: b.id, entryDate: entry, entryPrice: null, size: { mode: 'amount' as const, value: null }, exit: { kind: 'settle' as const } }
    })
    onAdd(ps, buckets)
  }
  return (
    <Modal title="Add markets" sub={`Markets that traded between ${long(r.start)} and ${long(r.end)} · sample market data (fictional)`} onClose={onClose} width={620}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!picked.size} onClick={add}>Add {picked.size || ''} position{picked.size === 1 ? '' : 's'}</Button></>}>
      {error ? <div className="empty"><p>Markets couldn’t be loaded.</p></div> : !events ? <div className="skeleton" style={{ height: 240 }} aria-busy="true" aria-label="Loading markets" /> : (
        <div className="rp-pick">
          {rows.map(({ key, m, why, inReplay }) => (
            <label key={key} className="rp-pick-i">
              <span className="row" style={{ minWidth: 0 }}><input type="checkbox" disabled={!!why} checked={picked.has(key)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(key); else n.delete(key); return n })} />
                <PlatformBadge p={m.provider} size={16} /><span style={{ minWidth: 0 }}>{m.marketTitle}<small>{m.listedAt ? `Opened ${long(m.listedAt)}` : 'Opening unknown'} · {m.closesAt ? `closed ${long(m.closesAt)}` : 'close not recorded'}{m.resolution ? ` · resolved ${m.resolution.outcome} ${long(m.resolution.at)}` : ''}</small></span></span>
              {why ? <small className="t3">{why}</small> : inReplay ? <small className="t3">{inReplay} in replay</small> : m.resolution ? <Chip>resolved</Chip> : null}
            </label>
          ))}
        </div>
      )}
      <small className="t3" style={{ display: 'block', marginTop: 'var(--space-3)' }}>No account is needed: virtual funding for the market’s venue is added if the replay has none. Resolved markets can be replayed for past periods; they can’t be traded today.</small>
    </Modal>
  )
}

/* ───────────── Analyze ───────────── */
function RatesEditor({ r, onChange, needed }: { r: Replay; onChange: (fn: (r: Replay) => Replay) => void; needed: Denomination[] }) {
  return (
    <details className="adv rp-rates">
      <summary>Reporting rates for an indicative USD total</summary>
      <p className="t3">Frozen with this replay. They only convert for reporting; they never move funds between buckets.</p>
      <div className="rp-grid">
        {(['USDC', 'PUSD'] as const).filter((d) => needed.includes(d)).map((d) => (
          <label key={d} className="rp-field">USD per 1 {d}<input className="rp-in num" type="number" inputMode="decimal" min={0.5} max={2} step={0.0001} placeholder="not set" value={r.rates[d] ?? ''} onChange={(e) => { const v = num(e.target.value); onChange((x) => ({ ...x, rates: { ...x.rates, [d]: v != null && v > 0 && v < 10 ? v : null } })) }} /></label>
        ))}
      </div>
    </details>
  )
}

function AnalyzeReplay({ res, onChange }: { res: ReplayResult; onChange: (fn: (r: Replay) => Replay) => void }) {
  const r = res.replay
  const from = res.supportedFrom ? res.series.findIndex((p) => p.date === res.supportedFrom) : -1
  const seg = from >= 0 ? res.series.slice(from) : []
  const vals = seg.map((p) => p.value as number)
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1)
  const nonUsd = res.byDenomination.map((d) => d.denomination).filter((d) => d !== 'USD')
  const short = res.buckets.filter((b) => b.shortfall > 0)
  return (<>
    {res.funding === 'unfunded' && <Callout tone="warn" icon="alert"><b>Unfunded what-if.</b> {short.map((b) => `${bucketLabel(b.bucket)} needed ${fmtNative(b.shortfall, b.bucket.denomination)} more simulated cash than it had at the time`).join('; ')}. Results are shown as a what-if, not as a funded portfolio, and returns aren’t calculated.{' '}
      {short.map((b) => <Button key={b.bucket.id} size="sm" onClick={() => onChange((x) => coverShortfall(x, b.bucket.id, b.shortfall))}>Add {fmtNative(Math.ceil(b.shortfall), b.bucket.denomination, 0)}</Button>)}</Callout>}
    {res.funding === 'unavailable' && <Callout tone="warn" icon="alert"><b>Funding can’t be assessed.</b> A fee before a purchase is unknown, so the cash available at that time is unknown. Known amounts are shown as partial.</Callout>}
    <section className="anchor" id="rp-results" aria-labelledby="rp-results-h">
      <h2 id="rp-results-h" className="sr-only">Results</h2>
      <div className="rp-kpis">
        {res.byDenomination.map((d) => (
          <div className="rp-kpi" key={d.denomination}><small>{d.denomination} · ending value · {FUNDING_LABEL[d.funding].toLowerCase()}</small><b>{d.endValue == null ? 'Unavailable' : fmtNative(d.endValue, d.denomination)}</b>
            <div className="rp-foot">From {fmtNative(d.capital, d.denomination)} · net gain {d.netGain == null ? 'unavailable' : sNative(d.netGain, d.denomination)} · return {d.ret == null ? 'unavailable' : `${d.ret >= 0 ? '+' : ''}${pct(d.ret * 100)}`}</div>
            <div className="rp-foot">Realized {d.realizedPnl == null ? 'unavailable' : sNative(d.realizedPnl, d.denomination)} · fees {d.fees == null ? 'unknown' : fmtNative(d.fees, d.denomination)}</div></div>
        ))}
        <div className="rp-kpi"><small>Largest drawdown</small><b>{res.drawdown ? kfmt(-res.drawdown.amount) : 'Unavailable'}</b><div className="rp-foot">{res.drawdown ? `${fmtDate(res.drawdown.from)} → ${fmtDate(res.drawdown.to)}` : 'Needs a complete value on every date of the replay'}</div></div>
        <div className="rp-kpi"><small>Indicative USD total</small><b>{res.combined ? fmtNative(res.combined.endValue, 'USD') : 'Unavailable'}</b>
          <div className="rp-foot">{res.combined ? <>Net gain {sNative(res.combined.netGain, 'USD')}{Object.entries(res.combined.rates).map(([d, v]) => ` · 1 ${d} = ${v} USD`).join('')}</> : res.combinedMissing === 'rate' ? `Set a reporting rate for ${nonUsd.join(' and ')} below` : 'Needs every native value'}</div></div>
      </div>
      {nonUsd.length > 0 && <RatesEditor r={r} onChange={onChange} needed={nonUsd} />}
    </section>

    <Card id="rp-value">
      <CardHeader title="Value over time" sub="Cash plus holdings at recorded prices; a price carries forward from its last observation, never backward" />
      <div className="card-b">
        {seg.length >= 2 ? (<>
          {from > 0 && <small className="t3">No eligible price before {long(seg[0].date)}: the chart starts there.</small>}
          <LineChart label={`Replay value from ${long(seg[0].date)} to ${long(r.end)}`} series={[{ data: vals, color: 'var(--color-accent-solid)' }]} min={lo} max={hi} yTicks={[lo, (lo + hi) / 2, hi]} yFmt={kfmt}
            xTicks={[[0, fmtDate(seg[0].date)], [seg.length - 1, fmtDate(seg.at(-1)!.date)]]}
            tooltip={(i) => <><div className="t3">{long(seg[i].date)}</div><b>{kfmt(vals[i])}</b><div className="t3">{seg[i].carried ? `${seg[i].carried} price${seg[i].carried === 1 ? '' : 's'} carried forward` : 'Observed prices'}{seg[i].stale ? ` · ${seg[i].stale} stale` : ''}</div></>} />
        </>) : (
          <div className="unavailable" role="status">
            Value over time is unavailable: {res.series.filter((p) => p.value != null).length} of {res.series.length} dates can be valued. {res.series.some((p) => !p.cashComplete) ? 'A fee is unknown, so cash after it is unknown. ' : ''}Open holdings need a recorded price on or before each date, and the sample market data only has today’s reference prices, not price history. Nothing is filled in.
          </div>
        )}
        {res.quality.qualified && seg.length >= 2 && <small className="t3">Some dates use stale carried-forward prices or are partial; return and drawdown are qualified.</small>}
      </div>
    </Card>

    <Card id="rp-lines" flush>
      <CardHeader pad title="Positions" sub="Exact figures for each position under the stated assumptions, in its funding’s native asset" />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Market</th><th scope="col">Outcome</th><th scope="col">Funding</th><th scope="col">Entry</th><th scope="col" className="r">Shares</th><th scope="col" className="r">Cost</th><th scope="col" className="r">Fee</th><th scope="col">End</th><th scope="col" className="r">Proceeds / value</th><th scope="col" className="r">Net P&amp;L</th></tr></thead>
        <tbody>{res.lines.map((l) => {
          const p = l.position, b = r.buckets.find((x) => x.id === p.bucketId)
          return (
            <tr key={p.id}>
              <td className="mkt"><div className="mk"><PlatformBadge p={p.market.provider} /><div><b>{p.market.title}</b><small>{p.market.category}</small></div></div></td>
              <td>{p.outcome}</td>
              <td className="t2">{b ? bucketLabel(b) : '—'}</td>
              <td className="t2">{fmtDate(p.entryDate)} at {p.entryPrice?.toFixed(2)}</td>
              <td className="r">{qty(l.shares)}</td>
              <td className="r">{l.cost.toFixed(2)}</td>
              <td className="r t2">{l.entryFee == null ? 'unknown' : l.entryFee.toFixed(2)}</td>
              <td className="t2">{l.end === 'settled' ? `Resolved ${p.market.resolution?.outcome} · ${fmtDate(l.endDate)}` : l.end === 'sold' ? `Sold ${fmtDate(l.endDate)} at ${(p.exit as { price: number }).price.toFixed(2)}` : `Open · ${l.endBasis ? BASIS_LABEL[l.endBasis].toLowerCase() : 'no price'}`}</td>
              <td className="r">{l.end === 'open' ? (l.endValue == null ? 'Unavailable' : l.endValue.toFixed(2)) : l.proceeds == null ? 'Unknown' : l.proceeds.toFixed(2)}</td>
              <td className={cx('r', l.pnl != null && (l.pnl >= 0 ? 'gain' : 'loss'))}>{l.pnl == null ? 'Unavailable' : sNative(l.pnl, b?.denomination ?? '')}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
    </Card>

    <Card id="rp-cash" flush>
      <CardHeader pad title="Cash flows" sub="Per virtual funding bucket, in its native asset, in time order" />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Date</th><th scope="col">Funding</th><th scope="col">Event</th><th scope="col" className="r">Amount</th><th scope="col" className="r">Fee</th></tr></thead>
        <tbody>{res.cash.map((c, i) => { const b = r.buckets.find((x) => x.id === c.bucketId); return (
          <tr key={i}><td className="t2">{long(c.date)}</td><td className="t2">{b ? bucketLabel(b) : '—'}</td><td>{c.note}</td><td className={cx('r', c.amount < 0 ? 'loss' : 'gain')}>{fmtNative(c.amount, b?.denomination ?? '')}</td><td className="r t2">{c.fee == null ? 'unknown' : c.fee.toFixed(2)}</td></tr>
        ) })}</tbody>
      </table></div>
    </Card>

    <Card id="rp-evidence" flush>
      <CardHeader pad title="Evidence" sub="What each market’s history in this replay is based on" />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Market</th><th scope="col">Trading opened</th><th scope="col">Trading close</th><th scope="col">Resolution</th><th scope="col" className="r">Recorded prices in period</th></tr></thead>
        <tbody>{res.evidence.map((e) => <tr key={`${e.provider}:${e.marketId}`}><td>{e.title}</td><td className="t2">{e.listed ? 'Recorded' : 'Unknown'}</td><td className="t2">{e.closeRecorded ? 'Recorded' : 'Not recorded'}</td><td className="t2">{e.resolution ? 'Recorded' : 'Not resolved'}</td><td className="r">{e.observationsInPeriod}</td></tr>)}</tbody>
      </table></div>
    </Card>
  </>)
}

/* ───────────── Compare ─────────────
   Normalized value (index = 100 at each replay's start) only where every compared replay has a complete series over
   the same period; otherwise an unavailable state. Figures whose basis differs are marked. */
function CompareReplays({ replays, today, activeKey }: { replays: Replay[]; today: string; activeKey: string }) {
  const [picked, setPicked] = useState<string[]>(() => [activeKey, ...replays.filter((r) => r.key !== activeKey).slice(-2).map((r) => r.key)])
  const evaluated = replays.filter((r) => picked.includes(r.key)).map((r) => { const i = validateReplay(r, today); return { r, res: replayValid(i) && r.positions.length ? runReplay(r, today) : null } })
  const ready = evaluated.filter((x): x is { r: Replay; res: ReplayResult } => !!x.res)
  const cmp = ready.length >= 2 ? compareReplays(ready.map((x) => x.res)) : null
  const diffs = cmp?.differences.filter((d) => d.differs) ?? []
  const indexable = !!cmp && !diffs.some((d) => d.key === 'period') && ready.every((x) => x.res.quality.complete && (x.res.series[0].value ?? 0) > 0)
  const idx = (res: ReplayResult) => res.series.map((p) => ((p.value as number) / (res.series[0].value as number)) * 100)
  const all = indexable ? ready.flatMap(({ res }) => idx(res)) : []
  const amounts = (x: ReplayResult, f: (d: ReplayResult['byDenomination'][number]) => number | null, signed = false) => x.byDenomination.map((d) => { const v = f(d); return v == null ? `${d.denomination} unavailable` : signed ? sNative(v, d.denomination, 0) : fmtNative(v, d.denomination, 0) }).join(' · ')
  const mark = (ok: boolean | undefined, text: string) => (cmp && !ok ? <span className="t3">{text} · not comparable</span> : text)
  return (
    <Card id="rp-compare">
      <CardHeader title="Compare replays" sub="Up to 4 · figures are compared only on a common basis" />
      <div className="card-b" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>{replays.map((r) => { const on = picked.includes(r.key); return (
          <button key={r.key} type="button" className={cx('pick-chip', on && 'on')} aria-pressed={on} disabled={!on && picked.length >= 4} onClick={() => setPicked((p) => (on ? p.filter((k) => k !== r.key) : [...p, r.key]))}><i style={{ background: r.color }} />{r.name}</button>
        ) })}</div>
        {replays.length < 2 && <p className="t3">Create another replay (or duplicate this one and change it) to compare.</p>}
        {evaluated.some((x) => !x.res) && <small className="t3">{evaluated.filter((x) => !x.res).map((x) => x.r.name).join(', ')}: not ready to analyze, so not compared.</small>}
        {cmp && (diffs.length ? <Callout icon="info">These replays differ in: {diffs.map((d) => d.label.toLowerCase()).join(', ')}.{cmp.reasons.length ? ` Not compared where ${cmp.reasons.join('; ')}.` : ''}</Callout> : <small className="t3">Same setup apart from the replay name.</small>)}
        {cmp && (indexable ? (
          <div>
            <div className="caps" style={{ marginBottom: 'var(--space-2)' }}>Value, indexed to 100 at the start</div>
            <LineChart label="Replay values indexed to 100 at the start" series={ready.map(({ r, res }) => ({ data: idx(res), color: r.color }))} min={Math.min(...all, 90)} max={Math.max(...all, 110)} yTicks={[90, 100, 110]} yFmt={(v) => v.toFixed(0)} xTicks={[[0, fmtDate(ready[0].res.series[0].date)], [ready[0].res.series.length - 1, fmtDate(ready[0].res.series.at(-1)!.date)]]} />
          </div>
        ) : <div className="unavailable" role="status">A normalized performance chart needs a complete value history over the same period for every replay. {ready.some((x) => !x.res.quality.complete) ? 'At least one replay has dates without recorded prices.' : 'The periods differ.'} Nothing is filled in.</div>)}
        {ready.length >= 1 && (
          <div className="dt-wrap"><table className="dt">
            <thead><tr><th scope="col">Replay</th>{ready.map(({ r }) => <th key={r.key} scope="col" className="r"><span className="row" style={{ justifyContent: 'flex-end' }}><i className="sw" style={{ background: r.color }} />{r.name}</span></th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">Period</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{fmtDate(r.start)} – {fmtDate(r.end)}</td>)}</tr>
              <tr><th scope="row">Funding</th>{ready.map(({ r, res }) => <td key={r.key} className={cx('r', res.funding !== 'funded' && 'stale')}>{FUNDING_LABEL[res.funding]}</td>)}</tr>
              <tr><th scope="row">Starting capital</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{amounts(res, (d) => d.capital)}</td>)}</tr>
              <tr><th scope="row">Positions · fees</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{r.positions.length} · {feeLabel(r.fees)}</td>)}</tr>
              <tr><th scope="row">Evidence</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{res.quality.complete ? 'Complete' : 'Partial'}</td>)}</tr>
              <tr><th scope="row">Ending value</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{mark(cmp?.amountsComparable, amounts(res, (d) => d.endValue))}</td>)}</tr>
              <tr><th scope="row">Net investment gain</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{mark(cmp?.amountsComparable, amounts(res, (d) => d.netGain, true))}</td>)}</tr>
              <tr><th scope="row">Return</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{res.combined?.ret == null ? 'Unavailable' : mark(cmp?.returnComparable, `${res.combined.ret >= 0 ? '+' : ''}${pct(res.combined.ret * 100)}`)}</td>)}</tr>
              <tr><th scope="row">Realized P&amp;L</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{mark(cmp?.amountsComparable, amounts(res, (d) => d.realizedPnl, true))}</td>)}</tr>
              <tr><th scope="row">Fees</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{amounts(res, (d) => d.fees)}</td>)}</tr>
              <tr><th scope="row">Largest drawdown</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{res.drawdown ? kfmt(res.drawdown.amount) : 'Unavailable'}</td>)}</tr>
            </tbody>
          </table></div>
        )}
        <small className="t3">All replays are hindsight analysis. Current-market scenarios aren’t compared here: a settlement range under outcomes you choose is a different measure from a historical return.</small>
      </div>
    </Card>
  )
}
