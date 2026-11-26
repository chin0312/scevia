/* Historical Replay (inside Scenario Lab): a retrospective hypothetical portfolio over a past period.
   Build (period, capital by account, markets with entry/exit and explicit execution prices) → Analyze (exact results
   for the stated assumptions, with evidence coverage) → Compare (replays on a common basis).
   It is hindsight analysis, labelled as such: markets are chosen knowing how they turned out. It never claims a
   strategy was executable, never values a holding without a recorded price, and never touches actual records. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { LineChart } from '../components/charts'
import { Icon } from '../components/Icon'
import { Modal, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, PlatformBadge, Seg, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import { MARKET_CATALOG } from '../data/markets'
import { TODAY } from '../data/portfolio'
import { addDays, fmtDate, type Outcome } from '../lib/finance'
import { feeLabel } from '../lib/fees'
import { fmt, fmtNative, kfmt, pct, qty, sfmt } from '../lib/format'
import { BASIS_LABEL } from '../lib/history'
import type { CatalogEvent } from '../lib/markets'
import { MAX_REPLAY_POSITIONS, compareReplays, replayMarketFrom, replayValid, runReplay, sanitizeReplays, validateReplay, type Replay, type ReplayAccount, type ReplayPosition, type ReplayResult } from '../lib/replay'
import { useSettings } from '../lib/settings'
import { useSessionState } from '../lib/useSessionState'
import { accountName } from '../lib/useWorkspace'
import { useActiveWorkspace } from '../lib/workspaceContext'
import { COLORS } from './lab/model'

export const REPLAYS_KEY = 'scevia-replays-v1'
type View = 'Build' | 'Analyze' | 'Compare'
const VIEWS = ['Build', 'Analyze', 'Compare'] as const
const RAILS: Record<View, RailSection[]> = {
  Build: [{ id: 'rp-setup', label: 'Period & capital', icon: 'cal' }, { id: 'rp-positions', label: 'Positions', icon: 'list' }],
  Analyze: [{ id: 'rp-results', label: 'Results', icon: 'spark' }, { id: 'rp-value', label: 'Value over time', icon: 'trend' }, { id: 'rp-lines', label: 'Positions', icon: 'table' }, { id: 'rp-cash', label: 'Cash flows', icon: 'db' }, { id: 'rp-evidence', label: 'Evidence', icon: 'shield' }],
  Compare: [{ id: 'rp-compare', label: 'Comparison', icon: 'compare' }],
}
const long = (d: string) => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' })
const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export default function ReplayPage() {
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { settings } = useSettings()
  const ws = useActiveWorkspace().snapshot
  const accounts: ReplayAccount[] = useMemo(() => ws.accounts.map((a) => ({ id: a.id, venue: a.venue, label: accountName(a.id), denomination: a.denomination })), [ws.accounts])
  const [replays, setReplays] = useSessionState<Replay[]>(REPLAYS_KEY, [], sanitizeReplays)
  const [view, setView] = useSessionState<View>('scevia-replay-view', 'Build', (v) => (VIEWS.includes(v as View) ? (v as View) : null))
  const [activeKey, setActiveKey] = useState<string | null>(() => params.get('open'))
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const create = () => {
    const key = `r${Date.now().toString(36)}`
    const r: Replay = { key, name: `Historical replay ${replays.length + 1}`, color: COLORS[replays.length % COLORS.length], start: addDays(TODAY, -182), end: TODAY, capital: {}, fees: settings.newFees === 'excluded' ? { mode: 'excluded' } : { mode: 'provider', role: 'taker' }, positions: [], basis: 'retrospective', createdAt: TODAY }
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
  const issues = active ? validateReplay(active, TODAY, accounts) : null
  const valid = !!issues && replayValid(issues) && active!.positions.length > 0
  const result = useMemo(() => (active && valid ? runReplay(active, accounts, TODAY) : null), [active, valid, accounts])
  const issueCount = issues ? (issues.period ? 1 : 0) + (issues.capital ? 1 : 0) + Object.keys(issues.positions).length : 0

  if (!active) return (
    <div className="shell">
      <SectionRail title="Historical Replay" sections={[{ id: 'rp-start', label: 'Start', icon: 'clock' }]} />
      <main className="lab-main">
        <section className="page-head anchor" id="rp-start"><div><div className="caps"><span className="accent">Scenario Lab</span> · Historical Replay · hindsight analysis</div><h1>Replay a portfolio over a past period</h1></div></section>
        <Card><div className="card-b" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <p className="t2">Choose a past period, starting capital per account and markets that traded then. Scevia applies the execution prices and fees you state, settles positions at their recorded resolution and values open holdings from recorded prices.</p>
          <p className="t3">You choose markets knowing how they turned out, so a replay is hindsight analysis: it shows what those exact trades would have done, not a strategy you could have followed at the time.</p>
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
            <Button icon="copy" onClick={() => { const key = `r${Date.now().toString(36)}`; setReplays((rs) => [...rs, { ...active, key, name: `${active.name} (copy)`.slice(0, 80), color: COLORS[rs.length % COLORS.length], positions: active.positions.map((p) => ({ ...p })) }]); setActiveKey(key); toast('Replay duplicated') }}>Duplicate</Button>
          </div>
        </section>
        <div className="lab-nav">
          <Tabs label="Replay views" options={VIEWS} value={view} onChange={(v) => { setView(v); window.scrollTo(0, 0) }}
            render={(o) => <span className="row" style={{ gap: 'var(--space-2)' }}>{o}{o === 'Build' && issueCount > 0 && <span className="tab-flag" aria-label={`${issueCount} to fix`}>{issueCount}</span>}{o === 'Compare' && <small className="t3">{replays.length}</small>}</span>} />
          <div className="assume-bar" role="group" aria-label="Replay assumptions">
            <span><span className="t3">Period</span> {long(active.start)} – {long(active.end)}</span>
            <span><span className="t3">Fees</span> {feeLabel(active.fees).toLowerCase()}</span>
            <span><span className="t3">Prices</span> your execution assumptions</span>
            <span><span className="t3">Selection</span> with hindsight</span>
          </div>
        </div>

        {view === 'Build' && <BuildReplay r={active} accounts={accounts} issues={issues!} onChange={update} onAdd={() => setAdding(true)} onAnalyze={() => { setView('Analyze'); window.scrollTo(0, 0) }} valid={valid} />}
        {view === 'Analyze' && (result ? <AnalyzeReplay res={result} /> : <Callout tone="warn" icon="alert">This replay can’t be analyzed yet: {active.positions.length === 0 ? 'add at least one position.' : `${issueCount} input${issueCount === 1 ? '' : 's'} in Build need${issueCount === 1 ? 's' : ''} attention.`} <button type="button" className="link" onClick={() => setView('Build')}>Go to Build</button></Callout>)}
        {view === 'Compare' && <CompareReplays replays={replays} accounts={accounts} activeKey={active.key} />}
        <div className="footer-note"><span>Historical replays apply your stated prices and fees to recorded market history with hindsight. They aren’t your actual performance, a strategy test or a recommendation.</span><span>{ws.summary.name} · sample market data</span></div>
      </main>

      {adding && <AddReplayMarkets r={active} onClose={() => setAdding(false)} accounts={accounts} onAdd={(ps) => { update((r) => ({ ...r, positions: [...r.positions, ...ps].slice(0, MAX_REPLAY_POSITIONS) })); setAdding(false); toast(`${ps.length} market${ps.length === 1 ? '' : 's'} added`) }} />}
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
function BuildReplay({ r, accounts, issues, onChange, onAdd, onAnalyze, valid }: { r: Replay; accounts: ReplayAccount[]; issues: ReturnType<typeof validateReplay>; onChange: (fn: (r: Replay) => Replay) => void; onAdd: () => void; onAnalyze: () => void; valid: boolean }) {
  const setPos = (id: string, patch: Partial<ReplayPosition>) => onChange((x) => ({ ...x, positions: x.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  return (<>
    <Callout icon="info">Hindsight analysis: you pick markets knowing how they resolved. Results show what these exact trades would have done at the prices you assume. They don’t show that the prices were available or that the choice could have been made at the time.</Callout>
    <Card id="rp-setup">
      <CardHeader title="Period & capital" sub="Capital stays in its account and native asset. Funds never move between accounts." />
      <div className="card-b" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="rp-period">
          <label>Start<input className="rp-in date" type="date" max={TODAY} value={r.start} aria-invalid={!!issues.period} onChange={(e) => onChange((x) => ({ ...x, start: e.target.value }))} /></label>
          <label>End<input className="rp-in date" type="date" max={TODAY} value={r.end} aria-invalid={!!issues.period} onChange={(e) => onChange((x) => ({ ...x, end: e.target.value }))} /></label>
          <div className="rp-field">Fees<Seg label="Fee assumption" options={['Provider estimate', 'Excluded'] as const} value={r.fees.mode === 'excluded' ? 'Excluded' : 'Provider estimate'} onChange={(v) => onChange((x) => ({ ...x, fees: v === 'Excluded' ? { mode: 'excluded' } : { mode: 'provider', role: 'taker' } }))} /></div>
        </div>
        {issues.period && <small className="rp-err" role="alert">{issues.period}</small>}
        <div className="rp-period">
          {accounts.map((a) => (
            <label key={a.id}><span className="row"><PlatformBadge p={a.venue} size={14} />{a.label} · {a.denomination}</span>
              <input className="rp-in num" inputMode="decimal" type="number" min={0} step="any" placeholder="0" aria-label={`Starting capital in ${a.label} (${a.denomination})`} value={r.capital[a.id] ?? ''} onChange={(e) => { const v = num(e.target.value); onChange((x) => ({ ...x, capital: { ...x.capital, [a.id]: v != null && v >= 0 ? v : 0 } })) }} /></label>
          ))}
        </div>
        {issues.capital && <small className="rp-err" role="alert">{issues.capital}</small>}
      </div>
    </Card>
    <Card id="rp-positions">
      <CardHeader title="Positions" sub={`${r.positions.length} of up to ${MAX_REPLAY_POSITIONS} · entries and exits at prices you state`} right={<Button icon="plus" onClick={onAdd} disabled={r.positions.length >= MAX_REPLAY_POSITIONS}>Add markets…</Button>} />
      <div className="card-b">
        {r.positions.length === 0 ? <div className="empty"><p>No positions yet. Add markets that traded during this period.</p><Button size="sm" icon="plus" onClick={onAdd}>Add markets…</Button></div> : (
          <div className="rp-rows">
            {r.positions.map((p) => {
              const err = issues.positions[p.id], m = p.market, onVenue = accounts.filter((a) => a.venue === m.provider)
              return (
                <div key={p.id} className={cx('rp-row', err && 'invalid')} role="group" aria-label={`${m.title} ${p.outcome}`}>
                  <div className="rp-row-h">
                    <div className="row" style={{ alignItems: 'flex-start', minWidth: 0 }}><PlatformBadge p={m.provider} /><div style={{ minWidth: 0 }}><b>{m.title}</b>
                      <small className="t3">{m.listedAt ? `Listed ${long(m.listedAt)}` : 'Listing date unknown'} · {m.resolution ? `resolved ${m.resolution.outcome} on ${long(m.resolution.at)}` : m.closesAt ? `trading closes ${long(m.closesAt)}` : 'close date unknown'}</small></div></div>
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${m.title}`} onClick={() => onChange((x) => ({ ...x, positions: x.positions.filter((q) => q.id !== p.id) }))} />
                  </div>
                  <div className="rp-grid">
                    <div className="rp-field">Outcome<Seg label={`Outcome for ${m.title}`} options={['YES', 'NO'] as const} value={p.outcome} onChange={(v: Outcome) => setPos(p.id, { outcome: v })} /></div>
                    <label className="rp-field">Account<select className="select" value={p.accountId} onChange={(e) => setPos(p.id, { accountId: e.target.value })}>{onVenue.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.denomination}</option>)}{onVenue.length === 0 && <option value="">No account on {PLATFORM_NAME[m.provider]}</option>}</select></label>
                    <label className="rp-field">Entry date<input className="rp-in date" type="date" min={m.listedAt ?? undefined} max={r.end} value={p.entryDate} onChange={(e) => setPos(p.id, { entryDate: e.target.value })} /></label>
                    <label className="rp-field">Execution price<input className="rp-in num" type="number" inputMode="decimal" min={0.01} max={0.99} step={0.01} placeholder="0.01–0.99" value={p.entryPrice ?? ''} onChange={(e) => setPos(p.id, { entryPrice: num(e.target.value) })} /></label>
                    <div className="rp-field">Size by<Seg label={`Size by for ${m.title}`} options={['Shares', '$ Amount', '% of capital'] as const} value={p.size.mode === 'shares' ? 'Shares' : p.size.mode === 'amount' ? '$ Amount' : '% of capital'} onChange={(v) => setPos(p.id, { size: { mode: v === 'Shares' ? 'shares' : v === '$ Amount' ? 'amount' : 'weight', value: p.size.value } })} /></div>
                    <label className="rp-field">{p.size.mode === 'shares' ? 'Shares' : p.size.mode === 'amount' ? 'Amount' : '% of account capital'}<input className="rp-in num" type="number" inputMode="decimal" min={0} step="any" value={p.size.value ?? ''} onChange={(e) => setPos(p.id, { size: { ...p.size, value: num(e.target.value) } })} /></label>
                    <div className="rp-field">Exit<Seg label={`Exit for ${m.title}`} options={['Hold to settlement', 'Sell on date'] as const} value={p.exit.kind === 'settle' ? 'Hold to settlement' : 'Sell on date'} onChange={(v) => setPos(p.id, { exit: v === 'Hold to settlement' ? { kind: 'settle' } : { kind: 'date', date: r.end, price: null } })} /></div>
                    {p.exit.kind === 'date' && <>
                      <label className="rp-field">Exit date<input className="rp-in date" type="date" min={p.entryDate} max={r.end} value={p.exit.date} onChange={(e) => setPos(p.id, { exit: { kind: 'date', date: e.target.value, price: p.exit.kind === 'date' ? p.exit.price : null } })} /></label>
                      <label className="rp-field">Exit price<input className="rp-in num" type="number" inputMode="decimal" min={0.01} max={0.99} step={0.01} placeholder="0.01–0.99" value={p.exit.price ?? ''} onChange={(e) => setPos(p.id, { exit: { kind: 'date', date: p.exit.kind === 'date' ? p.exit.date : r.end, price: num(e.target.value) } })} /></label>
                    </>}
                  </div>
                  {err && <small className="rp-err" role="alert">{err}</small>}
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

/* Market picker: sample catalog through the MarketCatalog interface. Markets listed after the period ends, or closed
   before it starts, can't be added. */
function AddReplayMarkets({ r, accounts, onClose, onAdd }: { r: Replay; accounts: ReplayAccount[]; onClose: () => void; onAdd: (ps: ReplayPosition[]) => void }) {
  const [events, setEvents] = useState<CatalogEvent[] | null>(null)
  const [error, setError] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => { let live = true; MARKET_CATALOG.search('').then((e) => { if (live) setEvents(e) }).catch(() => { if (live) setError(true) }); return () => { live = false } }, [])
  const present = new Set(r.positions.map((p) => p.market.marketId))
  const rows = (events ?? []).flatMap((ev) => ev.markets.map((m) => {
    const closes = m.resolution?.at ?? m.closesAt ?? null
    const why = present.has(m.marketId) ? 'in this replay' : m.listedAt && m.listedAt > r.end ? `listed ${long(m.listedAt)}, after the period` : closes && closes <= r.start ? `closed ${long(closes)}, before the period` : !accounts.some((a) => a.venue === m.provider) ? `no ${PLATFORM_NAME[m.provider]} account` : null
    return { ev, m, why }
  }))
  const add = () => onAdd(rows.filter((x) => picked.has(x.m.marketId)).map(({ ev, m }, i) => {
    const entry = m.listedAt && m.listedAt > r.start ? m.listedAt : r.start
    return { id: `rp${Date.now().toString(36)}${i}`, market: replayMarketFrom(ev, m), outcome: 'YES' as const, accountId: accounts.find((a) => a.venue === m.provider)?.id ?? '', entryDate: entry, entryPrice: null, size: { mode: 'amount' as const, value: null }, exit: { kind: 'settle' as const } }
  }))
  return (
    <Modal title="Add markets" sub={`Markets that traded between ${long(r.start)} and ${long(r.end)} · sample market data (fictional)`} onClose={onClose} width={620}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!picked.size} onClick={add}>Add {picked.size || ''} market{picked.size === 1 ? '' : 's'}</Button></>}>
      {error ? <div className="empty"><p>Markets couldn’t be loaded.</p></div> : !events ? <div className="skeleton" style={{ height: 240 }} aria-busy="true" aria-label="Loading markets" /> : (
        <div className="rp-pick">
          {rows.map(({ m, why }) => (
            <label key={m.marketId} className="rp-pick-i">
              <span className="row" style={{ minWidth: 0 }}><input type="checkbox" disabled={!!why} checked={picked.has(m.marketId)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(m.marketId); else n.delete(m.marketId); return n })} />
                <PlatformBadge p={m.provider} size={16} /><span style={{ minWidth: 0 }}>{m.marketTitle}<small>{m.listedAt ? `Listed ${long(m.listedAt)}` : 'Listing unknown'} · {m.resolution ? `resolved ${m.resolution.outcome} ${long(m.resolution.at)}` : `closes ${long(m.resolves)}`}</small></span></span>
              {why ? <small className="t3">{why}</small> : m.resolution ? <Chip>resolved</Chip> : null}
            </label>
          ))}
        </div>
      )}
      <small className="t3" style={{ display: 'block', marginTop: 'var(--space-3)' }}>Resolved markets can be replayed for past periods; they can’t be traded today. Execution prices are your assumption for every position.</small>
    </Modal>
  )
}

/* ───────────── Analyze ───────────── */
function AnalyzeReplay({ res }: { res: ReplayResult }) {
  const r = res.replay
  const valued = res.series.filter((p) => p.value != null)
  const vals = valued.map((p) => p.value as number)
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1)
  return (<>
    {res.hindsight && <Callout icon="info">This replay includes markets that have already resolved. Selecting them with that knowledge is hindsight: treat the result as an explanation of past trades, not as evidence of a repeatable strategy.</Callout>}
    <section className="anchor" id="rp-results" aria-labelledby="rp-results-h">
      <h2 id="rp-results-h" className="sr-only">Results</h2>
      <div className="rp-kpis">
        {res.byDenomination.map((d) => (
          <div className="rp-kpi" key={d.denomination}><small>{d.denomination} · ending value</small><b>{d.endValue == null ? 'Unavailable' : fmtNative(d.endValue, d.denomination)}</b>
            <div className="rp-foot">From {fmtNative(d.capital, d.denomination)} · net {d.netPnl == null ? 'unavailable' : fmtNative(d.netPnl, d.denomination)}{d.ret != null ? ` (${d.ret >= 0 ? '+' : ''}${pct(d.ret * 100)})` : ''}</div></div>
        ))}
        <div className="rp-kpi"><small>Realized net P&amp;L</small><b className={res.realizedPnl == null ? undefined : res.realizedPnl >= 0 ? 'gain' : 'loss'}>{res.realizedPnl == null ? 'Unavailable' : sfmt(res.realizedPnl, 2)}</b><div className="rp-foot">Settled and sold positions, after fees</div></div>
        <div className="rp-kpi"><small>Fees</small><b>{res.fees == null ? 'Unavailable' : `$${res.fees.toFixed(2)}`}</b><div className="rp-foot">{feeLabel(r.fees)}{res.fees == null ? ' · a market has no fee parameters' : ''}</div></div>
        <div className="rp-kpi"><small>Largest drawdown</small><b>{res.drawdown ? sfmt(-res.drawdown.amount, 2) : 'Unavailable'}</b><div className="rp-foot">{res.drawdown ? `${fmtDate(res.drawdown.from)} → ${fmtDate(res.drawdown.to)}` : 'Needs a value on every date of the replay'}</div></div>
        {res.combined && res.combined.assumed && <div className="rp-kpi"><small>Indicative combined total</small><b>{fmt(res.combined.endValue, 2)}</b><div className="rp-foot">Adds {res.byDenomination.map((d) => d.denomination).join(' and ')} as equal in value · net {sfmt(res.combined.netPnl, 2)}</div></div>}
      </div>
    </section>

    <Card id="rp-value">
      <CardHeader title="Value over time" sub="Cash plus holdings valued at recorded prices; a price carries forward from its last observation, never backward" />
      <div className="card-b">
        {res.quality.complete && valued.length >= 2 ? (
          <LineChart label={`Replay value from ${long(r.start)} to ${long(r.end)}`} series={[{ data: vals, color: 'var(--color-accent-solid)' }]} min={lo} max={hi} yTicks={[lo, (lo + hi) / 2, hi]} yFmt={kfmt}
            xTicks={[[0, fmtDate(valued[0].date)], [valued.length - 1, fmtDate(valued.at(-1)!.date)]]}
            tooltip={(i) => <><div className="t3">{long(valued[i].date)}</div><b>{kfmt(vals[i])}</b><div className="t3">{valued[i].carried ? `${valued[i].carried} price${valued[i].carried === 1 ? '' : 's'} carried forward` : 'Observed prices'}{valued[i].stale ? ` · ${valued[i].stale} stale` : ''}</div></>} />
        ) : (
          <div className="unavailable" role="status">
            Value over time is unavailable: {valued.length} of {res.series.length} dates can be valued. Open holdings need a recorded price on or before each date, and the sample market data only has today’s reference prices, not price history. Nothing is filled in. Results above use your stated prices, recorded resolutions and the prices recorded at the end of the period.
          </div>
        )}
        {res.quality.qualified && res.quality.complete && <small className="t3">More than a quarter of the dates use stale carried-forward prices; return and drawdown may be distorted.</small>}
      </div>
    </Card>

    <Card id="rp-lines" flush>
      <CardHeader pad title="Positions" sub="Exact figures for each position under the stated assumptions" />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Market</th><th scope="col">Outcome</th><th scope="col">Account</th><th scope="col">Entry</th><th scope="col" className="r">Shares</th><th scope="col" className="r">Cost</th><th scope="col" className="r">Fee</th><th scope="col">End</th><th scope="col" className="r">Proceeds / value</th><th scope="col" className="r">Net P&amp;L</th></tr></thead>
        <tbody>{res.lines.map((l) => {
          const p = l.position, a = res.accounts.find((x) => x.account.id === p.accountId)?.account
          return (
            <tr key={p.id}>
              <td className="mkt"><div className="mk"><PlatformBadge p={p.market.provider} /><div><b>{p.market.title}</b><small>{p.market.category}</small></div></div></td>
              <td>{p.outcome}</td>
              <td className="t2">{a?.label ?? '—'}<small className="t3" style={{ display: 'block' }}>{a?.denomination}</small></td>
              <td className="t2">{fmtDate(p.entryDate)} at {p.entryPrice?.toFixed(2)}</td>
              <td className="r">{qty(l.shares)}</td>
              <td className="r">{l.cost.toFixed(2)}</td>
              <td className="r t2">{l.entryFee == null ? 'unknown' : l.entryFee.toFixed(2)}</td>
              <td className="t2">{l.end === 'settled' ? `Resolved ${p.market.resolution?.outcome} · ${fmtDate(l.endDate)}` : l.end === 'sold' ? `Sold ${fmtDate(l.endDate)} at ${(p.exit as { price: number }).price.toFixed(2)}` : `Open · ${l.endBasis ? BASIS_LABEL[l.endBasis].toLowerCase() : 'no price'}`}</td>
              <td className="r">{l.end === 'open' ? (l.endValue == null ? 'Unavailable' : l.endValue.toFixed(2)) : l.proceeds == null ? 'Unavailable' : l.proceeds.toFixed(2)}</td>
              <td className={cx('r', l.pnl != null && (l.pnl >= 0 ? 'gain' : 'loss'))}>{l.pnl == null ? 'Unavailable' : sfmt(l.pnl, 2)}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
    </Card>

    <Card id="rp-cash" flush>
      <CardHeader pad title="Cash flows" sub="Per account, in its native asset, in time order" />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Date</th><th scope="col">Account</th><th scope="col">Event</th><th scope="col" className="r">Amount</th><th scope="col" className="r">Fee</th></tr></thead>
        <tbody>{res.cash.map((c, i) => { const a = res.accounts.find((x) => x.account.id === c.accountId)?.account; return (
          <tr key={i}><td className="t2">{long(c.date)}</td><td className="t2">{a?.label}</td><td>{c.note}</td><td className={cx('r', c.amount != null && c.amount < 0 ? 'loss' : 'gain')}>{c.amount == null ? 'unknown' : fmtNative(c.amount, a?.denomination ?? '')}</td><td className="r t2">{c.fee == null ? 'unknown' : c.fee.toFixed(2)}</td></tr>
        ) })}</tbody>
      </table></div>
      {res.accounts.some((a) => a.shortfall > 0) && <div className="card-b"><Callout tone="warn" icon="alert">{res.accounts.filter((a) => a.shortfall > 0).map((a) => `${a.account.label} needed ${fmtNative(a.shortfall, a.account.denomination)} more than it held at one point`).join('; ')}. Purchases are kept as if funded; add capital to that account for a funded replay.</Callout></div>}
    </Card>

    <Card id="rp-evidence" flush>
      <CardHeader pad title="Evidence" sub="What each market’s history in this replay is based on" />
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Market</th><th scope="col">Listing date</th><th scope="col">Resolution</th><th scope="col" className="r">Recorded prices in period</th></tr></thead>
        <tbody>{res.evidence.map((e) => <tr key={e.marketId}><td>{e.title}</td><td className="t2">{e.listed ? 'Recorded' : 'Unknown'}</td><td className="t2">{e.resolution ? 'Recorded' : 'Not resolved'}</td><td className="r">{e.observationsInPeriod}</td></tr>)}</tbody>
      </table></div>
    </Card>
  </>)
}

/* ───────────── Compare ───────────── */
function CompareReplays({ replays, accounts, activeKey }: { replays: Replay[]; accounts: ReplayAccount[]; activeKey: string }) {
  const [picked, setPicked] = useState<string[]>(() => replays.slice(-3).map((r) => r.key).includes(activeKey) ? replays.slice(-3).map((r) => r.key) : [activeKey, ...replays.filter((r) => r.key !== activeKey).slice(-2).map((r) => r.key)])
  const evaluated = replays.filter((r) => picked.includes(r.key)).map((r) => {
    const i = validateReplay(r, TODAY, accounts)
    return { r, res: replayValid(i) && r.positions.length ? runReplay(r, accounts, TODAY) : null }
  })
  const ready = evaluated.filter((x): x is { r: Replay; res: ReplayResult } => !!x.res)
  const cmp = ready.length >= 2 ? compareReplays(ready.map((x) => x.res)) : null
  const diffs = cmp?.differences.filter((d) => d.differs) ?? []
  return (
    <Card id="rp-compare">
      <CardHeader title="Compare replays" sub="Up to 4 · results are shown only where they’re comparable" />
      <div className="card-b" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>{replays.map((r) => { const on = picked.includes(r.key); return (
          <button key={r.key} type="button" className={cx('pick-chip', on && 'on')} aria-pressed={on} disabled={!on && picked.length >= 4} onClick={() => setPicked((p) => (on ? p.filter((k) => k !== r.key) : [...p, r.key]))}><i style={{ background: r.color }} />{r.name}</button>
        ) })}</div>
        {replays.length < 2 && <p className="t3">Create another replay (or duplicate this one and change it) to compare.</p>}
        {evaluated.some((x) => !x.res) && <small className="t3">{evaluated.filter((x) => !x.res).map((x) => x.r.name).join(', ')}: not ready to analyze, so not compared.</small>}
        {cmp && (diffs.length ? <Callout icon="info">These replays differ in: {diffs.map((d) => d.label.toLowerCase()).join(', ')}.{!cmp.pnlComparable ? ' Net P&L isn’t compared in absolute terms because starting capital differs; returns are.' : ''}{!cmp.returnComparable ? ' Returns aren’t compared because at least one replay can’t be valued completely.' : ''}</Callout> : <small className="t3">Same setup apart from the replay name.</small>)}
        {ready.length >= 1 && (
          <div className="dt-wrap"><table className="dt">
            <thead><tr><th scope="col">Replay</th>{ready.map(({ r }) => <th key={r.key} scope="col" className="r"><span className="row" style={{ justifyContent: 'flex-end' }}><i className="sw" style={{ background: r.color }} />{r.name}</span></th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">Period</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{fmtDate(r.start)} – {fmtDate(r.end)}</td>)}</tr>
              <tr><th scope="row">Starting capital</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{res.byDenomination.map((d) => fmtNative(d.capital, d.denomination, 0)).join(' · ')}</td>)}</tr>
              <tr><th scope="row">Positions</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{r.positions.length}</td>)}</tr>
              <tr><th scope="row">Fees</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{feeLabel(r.fees)}</td>)}</tr>
              <tr><th scope="row">Evidence</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{res.quality.complete ? 'Complete' : 'Partial'}</td>)}</tr>
              <tr><th scope="row">Realized net P&amp;L</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{res.realizedPnl == null ? 'Unavailable' : cmp && !cmp.pnlComparable ? <span className="t3">{sfmt(res.realizedPnl)} · not comparable</span> : sfmt(res.realizedPnl, 2)}</td>)}</tr>
              <tr><th scope="row">Ending value</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{res.byDenomination.map((d) => (d.endValue == null ? `${d.denomination} unavailable` : fmtNative(d.endValue, d.denomination, 0))).join(' · ')}</td>)}</tr>
              <tr><th scope="row">Return</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{res.combined?.ret == null ? 'Unavailable' : cmp && !cmp.returnComparable ? <span className="t3">not comparable</span> : `${res.combined.ret >= 0 ? '+' : ''}${pct(res.combined.ret * 100)}`}</td>)}</tr>
            </tbody>
          </table></div>
        )}
        <small className="t3">Current-market scenarios aren’t compared here: a settlement range under outcomes you choose is a different measure from a historical return.</small>
      </div>
    </Card>
  )
}
