/* Historical Replay (inside Scenario Lab): a retrospective hypothetical portfolio over a past period.
   Build (period, virtual funding, markets with entry/exit and explicit execution prices) → Analyze (exact results for
   the stated assumptions, funding status, evidence coverage) → Compare (replays on a common basis).
   It needs no portfolio or connected account: capital is virtual, per venue and native asset, and freely editable.
   It is hindsight analysis, labelled as such. It never claims a strategy was executable, never values a holding without
   a recorded price, never counts an unknown fee as zero and never touches actual records. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMarketCatalog } from '../lib/marketContext'
import { Link, useSearchParams } from 'react-router-dom'
import { LineChart } from '../components/charts'
import { Icon } from '../components/Icon'
import { Menu, Modal, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, PlatformBadge, Seg, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import type { Denomination, Platform } from '../data/types'
import { addDays, fmtDate, type Outcome } from '../lib/finance'
import { useFinanceCtx } from '../lib/financeContext'
import { feeLabel } from '../lib/fees'
import { fmt, fmtNative, kfmt, pct, qty, sfmt } from '../lib/format'
import { useReporting } from '../lib/reporting'
import { assetLabel } from '../lib/fx'
import { MarketDataLabel } from '../components/Workspace'
import { count, joinList, sentences } from '../lib/text'
import { BASIS_LABEL } from '../lib/history'
import type { CatalogEvent, CatalogMarket, LinkResolution } from '../lib/markets'
import {
  MAX_REPLAY_POSITIONS, bucketFor, bucketId, replayRates, compareReplays, coverShortfall, replayMarketFrom, replayValid, runReplay, sanitizeReplays, tradingWindow, validateReplay,
  type FrozenRates, type FundingBucket, type FundingStatus, type Replay, type ReplayPosition, type ReplayResult,
} from '../lib/replay'
import { useSettings } from '../lib/settings'
import { readStored, removeStored, scopedKey, writeStored } from '../lib/storage'
import { LAB_REPLAYS_KEY, mergeByKey } from './lab/baseline'
import { useSessionState } from '../lib/useSessionState'
import { COLORS } from './lab/model'
import { EvidenceBadges } from './lab/AddPosition'

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
const bucketLabel = (b: Pick<FundingBucket, 'venue' | 'denomination'>) => `${PLATFORM_NAME[b.venue]} ${assetLabel(b.denomination)}`
const FUNDING_LABEL: Record<FundingStatus, string> = { funded: 'Funded', unfunded: 'Not enough virtual funds', unavailable: 'Funding unknown' }

export default function ReplayPage() {
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { settings } = useSettings()
  const { F, workspaceId } = useFinanceCtx()
  const today = F.TODAY
  // Replays belong to the Scenario Lab collection, not a tracked portfolio. Ones kept per portfolio by earlier
  // versions are merged in once (by key) and their old keys removed.
  const [initial] = useState<Replay[]>(() => {
    let all = readStored<Replay[]>(LAB_REPLAYS_KEY, [], sanitizeReplays)
    const k = scopedKey(REPLAYS_KEY, workspaceId), legacy = readStored<Replay[] | null>(k, null, sanitizeReplays)
    if (legacy) { all = mergeByKey(all, legacy); if (writeStored(LAB_REPLAYS_KEY, all)) removeStored(k) }
    return all
  })
  const [replays, setReplays] = useSessionState<Replay[]>(LAB_REPLAYS_KEY, initial, sanitizeReplays)
  const [view, setView] = useSessionState<View>('scevia-replay-view', 'Build', (v) => (VIEWS.includes(v as View) ? (v as View) : null))
  const [activeKey, setActiveKey] = useState<string | null>(() => params.get('open'))
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const create = () => {
    const key = `r${Date.now().toString(36)}`
    const r: Replay = { key, name: `Historical replay ${replays.length + 1}`, color: COLORS[replays.length % COLORS.length], start: addDays(today, -182), end: today, buckets: [], fees: settings.newFees === 'excluded' ? { mode: 'excluded' } : { mode: 'provider', role: 'taker' }, rates: { USDC: null, PUSD: null }, refRates: capture(), positions: [], basis: 'retrospective', createdAt: today }
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
  // Combined reporting uses the exchange-rate service's references (per date; constant in the development fixture)
  // unless the replay overrides a rate as an explicit hypothetical assumption.
  // Each replay converts with the references frozen in it (captured when it was created, or when the user explicitly
  // takes newer ones) — never silently with whatever references are latest.
  const { fx, currency } = useReporting()
  const capture = (): FrozenRates => { const u = fx.reference('USDC', 'USD'), p = fx.reference('PUSD', 'USD'); return { USDC: u.rate, PUSD: p.rate, sources: { USDC: u.source, PUSD: p.source }, capturedAt: today } }
  const result = useMemo(() => (active && valid ? runReplay(active, today, replayRates(active)) : null), [active, valid, today])
  const issueCount = issues ? (issues.period ? 1 : 0) + (issues.capital ? 1 : 0) + Object.keys(issues.positions).length : 0

  if (!active) return (
    <div className="shell">
      <SectionRail title="Historical Replay" sections={[{ id: 'rp-start', label: 'Start', icon: 'clock' }]} />
      <main className="lab-main">
        <section className="page-head anchor" id="rp-start"><div><h1>Historical Replay</h1></div></section>
        <Card><div className="card-b" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <p className="t2">Choose a past period, set starting capital in virtual funds and add markets that traded then. Positions settle at each market’s recorded outcome. No connected account is needed.</p>
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
            <div className="caps"><span className="accent">Historical Replay</span></div>
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
                        <span><span className="t3">Fees</span> {feeLabel(active.fees).toLowerCase()}</span>
            <span><span className="t3">Prices</span> entered by you</span>
          </div>
        </div>

        {view === 'Build' && <BuildReplay r={active} issues={issues!} result={result} onChange={update} onAdd={() => setAdding(true)} onAnalyze={() => { setView('Analyze'); window.scrollTo(0, 0) }} valid={valid} />}
        {view === 'Analyze' && (result ? <AnalyzeReplay res={result} onChange={update} currency={currency} latest={capture()} /> : <Callout tone="warn" icon="alert">This replay can’t be analyzed yet: {active.positions.length === 0 ? 'add at least one position.' : `${issueCount} input${issueCount === 1 ? '' : 's'} in Build need${issueCount === 1 ? 's' : ''} attention.`} <button type="button" className="link" onClick={() => setView('Build')}>Go to Build</button></Callout>)}
        {view === 'Compare' && <CompareReplays replays={replays} today={today} activeKey={active.key} />}
        <div className="footer-note"><span>A replay shows what these trades would have done. It isn’t your actual performance or a tested strategy.</span><span><MarketDataLabel /></span></div>
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
      <CardHeader title="Period and starting capital" sub="Virtual funds for each platform and settlement currency. They don’t move between each other." />
      <div className="card-b" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="rp-period">
          <label>Start<input className="rp-in date" type="date" max={r.end} value={r.start} aria-invalid={!!issues.period} onChange={(e) => onChange((x) => ({ ...x, start: e.target.value }))} /></label>
          <label>End<input className="rp-in date" type="date" value={r.end} aria-invalid={!!issues.period} onChange={(e) => onChange((x) => ({ ...x, end: e.target.value }))} /></label>
          <div className="rp-field">Fees<Seg label="Fee assumption" options={['Provider estimate', 'Excluded'] as const} value={r.fees.mode === 'excluded' ? 'Excluded' : 'Provider estimate'} onChange={(v) => onChange((x) => ({ ...x, fees: v === 'Excluded' ? { mode: 'excluded' } : { mode: 'provider', role: 'taker' } }))} /></div>
        </div>
        {issues.period && <small className="rp-err" role="alert">{issues.period}</small>}
        <div className="rp-buckets" role="group" aria-label="Virtual funding">
          {r.buckets.length === 0 && <p className="t3">No virtual funds yet. They’re added when you add a market, or you can add them here.</p>}
          {r.buckets.map((b) => {
            const used = r.positions.some((p) => p.bucketId === b.id), res = result?.buckets.find((x) => x.bucket.id === b.id)
            return (
              <div key={b.id} className="rp-bucket">
                <span className="row"><PlatformBadge p={b.venue} size={16} /><b>{bucketLabel(b)}</b></span>
                <label className="rp-field">Starting capital<input className="rp-in num" inputMode="decimal" type="number" min={0} step="any" placeholder="0" aria-label={`Starting capital, ${bucketLabel(b)}`} value={b.capital || ''} onChange={(e) => { const v = num(e.target.value); onChange((x) => ({ ...x, buckets: x.buckets.map((y) => (y.id === b.id ? { ...y, capital: v != null && v >= 0 ? v : 0 } : y)) })) }} /></label>
                <span className="rp-field">Cash at the end<b className="tnum">{res ? (res.cashComplete ? fmtNative(res.knownCash, b.denomination) : `${fmtNative(res.knownCash, b.denomination)} known`) : '—'}</b></span>
                {res && res.shortfall > 0 && <span className="rp-short" role="status"><span className="stale">Funding shortfall {fmtNative(res.shortfall, b.denomination)}</span><Button size="sm" onClick={() => onChange((x) => coverShortfall(x, b.id, res.shortfall))}>Add {fmtNative(Math.ceil(res.shortfall), b.denomination, 0)}</Button></span>}
                {res && res.funding === 'unavailable' && <small className="t3">Remaining budget unknown: a fee before a purchase is unknown.</small>}
                <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${bucketLabel(b)}`} disabled={used} title={used ? 'Positions use this funding' : undefined} onClick={() => onChange((x) => ({ ...x, buckets: x.buckets.filter((y) => y.id !== b.id) }))} />
              </div>
            )
          })}
          {missing.length > 0 && <Menu label="Add virtual funds" align="left" width={260} trigger={(t) => <button type="button" className="link" {...t}>+ Add virtual funds</button>}>
            {(close) => missing.map(({ venue, d }) => <button key={`${venue}${d}`} type="button" role="menuitem" className="menu-i" onClick={() => { close(); addBucket(venue, d) }}><PlatformBadge p={venue} size={14} />{PLATFORM_NAME[venue]} {assetLabel(d)}</button>)}
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
    <p className="t3 rp-note"><Icon name="info" size={14} /> You choose these markets knowing how they turned out. Results use the prices you enter, which may not have been available at the time.</p>
    <FundingCard r={r} issues={issues} result={result} onChange={onChange} />
    <Card id="rp-positions">
      <CardHeader title="Positions" sub={`${r.positions.length} of up to ${MAX_REPLAY_POSITIONS}`} right={<Button icon="plus" onClick={onAdd} disabled={r.positions.length >= MAX_REPLAY_POSITIONS}>Add markets…</Button>} />
      <div className="card-b">
        {r.positions.length === 0 ? <div className="empty"><p>No positions yet. Add markets that traded during this period.</p><Button size="sm" icon="plus" onClick={onAdd}>Add markets…</Button></div> : (
          <div className="rp-rows">
            {r.positions.map((p, i) => {
              const err = issues.positions[p.id], cav = issues.caveats[p.id], m = p.market, onVenue = r.buckets.filter((b) => b.venue === m.provider && b.denomination === m.denomination)
              const n = r.positions.filter((q) => q.market.provider === m.provider && q.market.marketId === m.marketId).length
              return (
                <div key={p.id} className={cx('rp-row', err && 'invalid')} role="group" aria-label={`Position ${i + 1}: ${m.title} ${p.outcome}`}>
                  <div className="rp-row-h">
                    <div className="row" style={{ alignItems: 'flex-start', minWidth: 0 }}><PlatformBadge p={m.provider} /><div style={{ minWidth: 0 }}><b>{m.title}</b>
                      <small className="t3">{m.listedAt ? `Opened ${long(m.listedAt)}` : 'Opening date unknown'}. {m.closesAt ? `Trading closed ${long(m.closesAt)}` : 'Trading close not recorded'}. {m.resolution ? `Resolved ${m.resolution.outcome} on ${long(m.resolution.at)}` : m.expectedResolution ? `Expected to resolve ${long(m.expectedResolution)}` : 'Resolution date unknown'}.{n > 1 ? ` ${n} positions in this market.` : ''}</small></div></div>
                    <span className="row" style={{ gap: 0 }}>
                      <Button size="sm" variant="ghost" icon="copy" aria-label={`Add another position in ${m.title}`} title="Add another position in this market" onClick={() => another(p)} disabled={r.positions.length >= MAX_REPLAY_POSITIONS} />
                      <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove position ${i + 1}`} onClick={() => onChange((x) => ({ ...x, positions: x.positions.filter((q) => q.id !== p.id) }))} />
                    </span>
                  </div>
                  <div className="rp-grid">
                    <div className="rp-field">Outcome<Seg label={`Outcome for position ${i + 1}`} options={['YES', 'NO'] as const} value={p.outcome} onChange={(v: Outcome) => setPos(p.id, { outcome: v })} /></div>
                    <label className="rp-field">Virtual funds{m.denomination ? ` (${assetLabel(m.denomination)})` : ''}<select className="select" value={p.bucketId} onChange={(e) => setPos(p.id, { bucketId: e.target.value })}>{onVenue.map((b) => <option key={b.id} value={b.id}>{bucketLabel(b)}</option>)}</select></label>
                    <label className="rp-field">Entry date<input className="rp-in date" type="date" min={m.listedAt?.slice(0, 10) ?? undefined} max={r.end} value={p.entryDate} onChange={(e) => setPos(p.id, { entryDate: e.target.value })} /></label>
                    <label className="rp-field">Entry price<input className="rp-in num" type="number" inputMode="decimal" min={0.01} max={0.99} step={0.01} placeholder="0.01–0.99" value={p.entryPrice ?? ''} onChange={(e) => setPos(p.id, { entryPrice: num(e.target.value) })} /></label>
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

/* Market picker (through the shared MarketCatalog). Search by title, or resolve an exact provider link or native id
   (an explicit mode). Each pick is an exact outcome (provider + market + outcome) and survives query changes; the
   basket lists exactly the positions that will be added. Funding is matched by venue AND the market's own settlement
   asset (a compatible empty bucket is created if needed); a market whose asset isn't established can't be added. */
type ReplayPick = { key: string; ev: CatalogEvent; m: CatalogMarket; outcome: Outcome }
function AddReplayMarkets({ r, onClose, onAdd }: { r: Replay; onClose: () => void; onAdd: (ps: ReplayPosition[], buckets: FundingBucket[]) => void }) {
  const MARKET_CATALOG = useMarketCatalog()
  const [found, setFound] = useState<{ q: string; events: CatalogEvent[]; outcome: LinkResolution | null; error: boolean } | null>(null)
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'Search' | 'Link or id'>('Search')
  const [picks, setPicks] = useState<ReplayPick[]>([])
  const seq = useRef(0)
  // Only the latest request may publish; closing the dialog drops anything still in flight.
  useEffect(() => {
    const n = ++seq.current, term = q.trim(), key = `${mode}:${term}`
    if (mode === 'Link or id' && !term) { setFound({ q: key, events: [], outcome: null, error: false }); return }
    const t = window.setTimeout(() => {
      const run: Promise<{ events: CatalogEvent[]; outcome: LinkResolution | null }> = mode === 'Link or id'
        ? MARKET_CATALOG.resolveLink(term).then((res) => ({ events: res.status === 'resolved' ? [res.event] : [], outcome: res }))
        : MARKET_CATALOG.search(term).then((events) => ({ events, outcome: null }))
      run.then((x) => { if (n === seq.current) setFound({ q: key, ...x, error: false }) }).catch(() => { if (n === seq.current) setFound({ q: key, events: [], outcome: null, error: true }) })
    }, 150)
    return () => window.clearTimeout(t)
  }, [q, mode, MARKET_CATALOG])
  useEffect(() => () => { seq.current++ }, [])
  const current = found && found.q === `${mode}:${q.trim()}` ? found : null
  const why = (m: CatalogMarket) => {
    const rm = replayMarketFrom({ provider: m.provider, eventId: '', eventTitle: '', url: '', available: true, markets: [] }, m)
    const closedBefore = m.closesAt ? m.closesAt.slice(0, 10) < r.start : !!m.resolution && m.resolution.at.slice(0, 10) <= r.start
    return !m.denomination ? 'settlement asset not established'
      : m.listedAt && m.listedAt.slice(0, 10) > r.end ? `opened ${long(m.listedAt)}, after the period`
      : closedBefore && !tradingWindow(rm, r.start).ok ? `closed ${long(m.closesAt ?? m.resolution!.at)}, before the period` : null
  }
  const pk = (m: CatalogMarket, o: Outcome) => `${m.provider}:${m.marketId}:${o}`
  const toggle = (ev: CatalogEvent, m: CatalogMarket, o: Outcome) => setPicks((ps) => (ps.some((p) => p.key === pk(m, o)) ? ps.filter((p) => p.key !== pk(m, o)) : [...ps, { key: pk(m, o), ev, m, outcome: o }]))
  const add = () => {
    let buckets = [...r.buckets]
    const added: FundingBucket[] = []
    const ps = picks.map(({ ev, m, outcome }, i) => {
      const rm = replayMarketFrom(ev, m)
      const b = bucketFor(buckets, rm)!
      if (!buckets.some((x) => x.id === b.id)) { buckets = [...buckets, b]; added.push(b) }
      const entry = m.listedAt && m.listedAt.slice(0, 10) > r.start ? m.listedAt.slice(0, 10) : r.start
      return { id: `rp${Date.now().toString(36)}${i}`, market: rm, outcome, bucketId: b.id, entryDate: entry, entryPrice: null, size: { mode: 'amount' as const, value: null }, exit: { kind: 'settle' as const } }
    })
    onAdd(ps, added)
  }
  const o = current?.outcome
  return (
    <Modal title="Add markets" sub={sentences(`Markets that traded between ${long(r.start)} and ${long(r.end)}`, !MARKET_CATALOG.live && MARKET_CATALOG.label)} onClose={onClose} width={640}
      footer={<><span className="t3" style={{ marginRight: 'auto' }}>{picks.length ? `${picks.length} selected` : 'Choose an outcome for each position'}</span><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!picks.length} onClick={add}>Add {picks.length || ''} position{picks.length === 1 ? '' : 's'}</Button></>}>
      <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Seg label="Find by" options={['Search', 'Link or id'] as const} value={mode} onChange={(v) => setMode(v)} />
        <input className="text-input" style={{ flex: 1, minWidth: 220 }} type="search" aria-label={mode === 'Search' ? 'Search markets' : 'Market link or id'} placeholder={mode === 'Search' ? 'Search events or markets' : 'Paste a Polymarket or Kalshi link, or a market id'} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div aria-live="polite">
        {!current ? <><small className="t3" role="status">{mode === 'Search' ? 'Searching' : 'Resolving market'}{q.trim() ? ` “${q.trim()}”` : ''}…</small><div className="skeleton" style={{ height: 200 }} aria-busy="true" /></>
          : current.error ? <Callout tone="warn" icon="alert">Market search isn’t available right now. Your replay is unaffected and nothing is shown in its place.</Callout>
          : o && o.status === 'invalid' ? <Callout tone="warn" icon="alert">{o.message}</Callout>
          : o && o.status === 'unsupported' ? <Callout tone="warn" icon="alert">Links from {o.host} aren’t supported. Use a Polymarket or Kalshi link or market id.</Callout>
          : o && o.status === 'unsupported-market' ? <Callout tone="warn" icon="alert">This {PLATFORM_NAME[o.provider]} market type isn’t supported: {o.reason}</Callout>
          : o && o.status === 'not-found' ? <Callout icon="info">No {PLATFORM_NAME[o.provider]} market found for this link.</Callout>
          : o && o.status === 'unavailable' ? <Callout tone="warn" icon="alert">{o.eventTitle}: market data is unavailable.</Callout>
          : o && (o.status === 'temporarily-unavailable' || o.status === 'access-unavailable') ? <Callout tone="warn" icon="alert">{o.status === 'temporarily-unavailable' ? 'Market data is temporarily unavailable.' : 'Market data access isn’t available.'} Nothing is shown in its place.</Callout>
          : mode === 'Link or id' && !q.trim() ? <p className="t3">Paste an exact market link or a provider market id.</p>
          : current.events.length === 0 ? <div className="empty"><p>No markets found{q.trim() ? ` for “${q.trim()}”` : ''}.</p></div>
          : (
            <div className="rp-pick">
              {current.events.flatMap((ev) => ev.markets.map((m) => {
                const w = why(m), n = r.positions.filter((p) => p.market.provider === m.provider && p.market.marketId === m.marketId).length
                return (
                  <div key={`${m.provider}:${m.marketId}`} className="rp-pick-i" role="group" aria-label={m.marketTitle}>
                    <span className="row" style={{ minWidth: 0 }}><PlatformBadge p={m.provider} size={16} /><span style={{ minWidth: 0 }}>{m.marketTitle}<EvidenceBadges m={m} />
                      <small>{m.denomination ? `Settles in ${assetLabel(m.denomination)}` : 'Settlement currency unknown'}. {m.listedAt ? `Opened ${long(m.listedAt)}` : 'Opening date unknown'}{m.closesAt ? `, closed ${long(m.closesAt)}` : ''}{m.resolution ? `, resolved ${m.resolution.outcome} ${long(m.resolution.at)}` : ''}.{n ? ` ${n} in this replay.` : ''}</small></span></span>
                    {w ? <small className="t3">{w}</small> : (
                      <span className="addpos-outcomes">{(['YES', 'NO'] as Outcome[]).map((oc) => { const on = picks.some((p) => p.key === pk(m, oc)); return (
                        <button key={oc} type="button" className={cx('outcome-btn', oc === 'YES' ? 'yes' : 'no', on && 'on')} aria-pressed={on} aria-label={`${on ? 'Deselect' : 'Select'} ${m.marketTitle} ${oc}`} onClick={() => toggle(ev, m, oc)}><b>{oc}</b><span>{on ? 'selected' : 'select'}</span></button>
                      ) })}</span>
                    )}
                  </div>
                )
              }))}
            </div>
          )}
      </div>
      {picks.length > 0 && <div className="addpos-basket" aria-label="Selected positions">{picks.map((p) => <span key={p.key} className="chip">{p.m.marketTitle} {p.outcome} ({assetLabel(p.m.denomination ?? '')})<button type="button" className="link" aria-label={`Remove ${p.m.marketTitle} ${p.outcome}`} onClick={() => setPicks((ps) => ps.filter((x) => x.key !== p.key))}>×</button></span>)}</div>}
      <small className="t3" style={{ display: 'block', marginTop: 'var(--space-3)' }}>Each position uses virtual funds in its market’s settlement currency. They’re added if the replay has none. Resolved markets can be replayed but not traded today.</small>
    </Modal>
  )
}

/* ───────────── Analyze ───────────── */
/** The references this replay converts with (frozen), and an explicit way to take newer ones. */
function FrozenRatesLine({ r, latest, needed, onChange }: { r: Replay; latest: FrozenRates; needed: Denomination[]; onChange: (fn: (r: Replay) => Replay) => void }) {
  const assets = needed.filter((d): d is 'USDC' | 'PUSD' => d === 'USDC' || d === 'PUSD')
  const differs = !r.refRates || assets.some((a) => r.refRates![a] !== latest[a])
  return (
    <p className="t3 rp-frozen" role="status">
      {r.refRates ? <>Combined using rates saved on {fmtDate(r.refRates.capturedAt.slice(0, 10))}: {assets.map((a) => `1 ${assetLabel(a)} = ${r.refRates![a] ?? 'unavailable'} USD`).join(', ')}. Sample rates.</> : <>No rates were saved with this replay, so the combined total is unavailable.</>}
      {differs && <> <button type="button" className="link" onClick={() => onChange((x) => ({ ...x, refRates: latest }))}>{r.refRates ? 'Use latest rates' : 'Save current rates'}</button></>}
    </p>
  )
}

function RatesEditor({ r, onChange, needed }: { r: Replay; onChange: (fn: (r: Replay) => Replay) => void; needed: Denomination[] }) {
  return (
    <details className="adv rp-rates">
      <summary>Use your own rates</summary>
      <p className="t3">By default each stablecoin uses its reference rate. Your own rate is saved with this replay and used for every date. It never moves funds.</p>
      <div className="rp-grid">
        {(['USDC', 'PUSD'] as const).filter((d) => needed.includes(d)).map((d) => (
          <label key={d} className="rp-field">USD per 1 {d}<input className="rp-in num" type="number" inputMode="decimal" min={0.5} max={2} step={0.0001} placeholder="reference" value={r.rates[d] ?? ''} onChange={(e) => { const v = num(e.target.value); onChange((x) => ({ ...x, rates: { ...x.rates, [d]: v != null && v > 0 && v < 10 ? v : null } })) }} /></label>
        ))}
      </div>
    </details>
  )
}

function AnalyzeReplay({ res, onChange, currency, latest }: { res: ReplayResult; onChange: (fn: (r: Replay) => Replay) => void; currency: string; latest: FrozenRates }) {
  const r = res.replay
  const from = res.supportedFrom ? res.series.findIndex((p) => p.date === res.supportedFrom) : -1
  const seg = from >= 0 ? res.series.slice(from) : []
  const vals = seg.map((p) => p.value as number)
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1)
  const nonUsd = res.byDenomination.map((d) => d.denomination).filter((d) => d !== 'USD')
  const short = res.buckets.filter((b) => b.shortfall > 0)
  return (<>
    {res.funding === 'unfunded' && <Callout tone="warn" icon="alert"><b>Not enough virtual funds.</b> {short.map((b) => `${bucketLabel(b.bucket)} needed ${fmtNative(b.shortfall, b.bucket.denomination)} more`).join(', ')}. Returns aren’t calculated until the replay is funded.{' '}
      {short.map((b) => <Button key={b.bucket.id} size="sm" onClick={() => onChange((x) => coverShortfall(x, b.bucket.id, b.shortfall))}>Add {fmtNative(Math.ceil(b.shortfall), b.bucket.denomination, 0)}</Button>)}</Callout>}
    {res.funding === 'unavailable' && <Callout tone="warn" icon="alert"><b>Funding can’t be assessed.</b> A fee before a purchase is unknown, so the cash available at that time is unknown. Known amounts are shown as partial.</Callout>}
    <section className="anchor" id="rp-results" aria-labelledby="rp-results-h">
      <h2 id="rp-results-h" className="sr-only">Results</h2>
      <div className="rp-kpis">
        {res.byDenomination.map((d) => (
          <div className="rp-kpi" key={d.denomination}><small>Ending value in {assetLabel(d.denomination)}{d.funding !== 'funded' ? ` (${FUNDING_LABEL[d.funding].toLowerCase()})` : ''}</small><b>{d.endValue == null ? 'Unavailable' : fmtNative(d.endValue, d.denomination)}</b>
            <div className="rp-foot">Started with {fmtNative(d.capital, d.denomination)}. Gain {d.netGain == null ? 'unavailable' : sNative(d.netGain, d.denomination)}, return {d.ret == null ? 'unavailable' : `${d.ret >= 0 ? '+' : ''}${pct(d.ret * 100)}`}.</div>
            <div className="rp-foot">Realized {d.realizedPnl == null ? 'unavailable' : sNative(d.realizedPnl, d.denomination)}, fees {d.fees == null ? 'unknown' : fmtNative(d.fees, d.denomination)}.</div></div>
        ))}
        <div className="rp-kpi"><small>Largest drawdown</small><b>{res.drawdown ? kfmt(-res.drawdown.amount) : 'Unavailable'}</b><div className="rp-foot">{res.drawdown ? `${fmtDate(res.drawdown.from)} → ${fmtDate(res.drawdown.to)}` : 'Needs a value for every date'}</div></div>
        <div className="rp-kpi"><small>Total in {currency}</small><b>{res.combined ? fmt(res.combined.endValue, 2) : 'Unavailable'}</b>
          <div className="rp-foot">{res.combined ? <>Started with {fmt(res.combined.capital, 2)}. Gain {sfmt(res.combined.netGain, 2)}{res.combined.ret != null ? ` (${res.combined.ret >= 0 ? '+' : ''}${pct(res.combined.ret * 100)})` : ''}.{res.combined.basis !== 'reference' ? ' Uses your own rates.' : ''}</> : res.combinedMissing === 'rate' ? `No ${joinList(nonUsd.map(assetLabel), 'or')} rate. See the results above.` : 'Needs every result above'}</div></div>
      </div>
      {nonUsd.length > 0 && <FrozenRatesLine r={r} latest={latest} needed={nonUsd} onChange={onChange} />}
      {nonUsd.length > 0 && <RatesEditor r={r} onChange={onChange} needed={nonUsd} />}
    </section>

    <Card id="rp-value">
      <CardHeader title="Value over time" sub="Cash plus holdings at historical prices" />
      <div className="card-b">
        {seg.length >= 2 ? (<>
          {from > 0 && <small className="t3">No eligible price before {long(seg[0].date)}: the chart starts there.</small>}
          <LineChart label={`Replay value from ${long(seg[0].date)} to ${long(r.end)}`} series={[{ data: vals, color: 'var(--color-accent-solid)' }]} min={lo} max={hi} yTicks={[lo, (lo + hi) / 2, hi]} yFmt={kfmt}
            xTicks={[[0, fmtDate(seg[0].date)], [seg.length - 1, fmtDate(seg.at(-1)!.date)]]}
            tooltip={(i) => <><div className="t3">{long(seg[i].date)}</div><b>{kfmt(vals[i])}</b><div className="t3">{seg[i].carried ? `${seg[i].carried} price${seg[i].carried === 1 ? '' : 's'} carried forward` : 'Observed prices'}{seg[i].stale ? `, ${seg[i].stale} out of date` : ''}</div></>} />
        </>) : (
          <div className="unavailable" role="status">
            Value over time is unavailable: {res.series.filter((p) => p.value != null).length} of {count(res.series.length, 'date')} can be valued. {res.series.some((p) => !p.cashComplete) ? 'A fee is unknown, so cash after it is unknown. ' : ''}Open holdings need a recorded price on or before each date, and the sample market data only has today’s reference prices, not price history. Nothing is filled in.
          </div>
        )}
        {res.quality.qualified && seg.length >= 2 && <small className="t3">Some dates use older or partial prices, so return and drawdown are approximate.</small>}
      </div>
    </Card>

    <Card id="rp-lines" flush>
      <CardHeader pad title="Positions" sub="Each position in its settlement currency" />
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
              <td className="t2">{l.end === 'settled' ? `Resolved ${p.market.resolution?.outcome} on ${fmtDate(l.endDate)}` : l.end === 'sold' ? `Sold ${fmtDate(l.endDate)} at ${(p.exit as { price: number }).price.toFixed(2)}` : `Open, ${l.endBasis ? BASIS_LABEL[l.endBasis].toLowerCase() : 'no price'}`}</td>
              <td className="r">{l.end === 'open' ? (l.endValue == null ? 'Unavailable' : l.endValue.toFixed(2)) : l.proceeds == null ? 'Unknown' : l.proceeds.toFixed(2)}</td>
              <td className={cx('r', l.pnl != null && (l.pnl >= 0 ? 'gain' : 'loss'))}>{l.pnl == null ? 'Unavailable' : sNative(l.pnl, b?.denomination ?? '')}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
    </Card>

    <Card id="rp-cash" flush>
      <CardHeader pad title="Cash flows" sub="Virtual funds by platform and currency, in date order" />
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
  const evaluated = replays.filter((r) => picked.includes(r.key)).map((r) => { const i = validateReplay(r, today); return { r, res: replayValid(i) && r.positions.length ? runReplay(r, today, replayRates(r)) : null } })
  const ready = evaluated.filter((x): x is { r: Replay; res: ReplayResult } => !!x.res)
  const cmp = ready.length >= 2 ? compareReplays(ready.map((x) => x.res)) : null
  const diffs = cmp?.differences.filter((d) => d.differs) ?? []
  const indexable = !!cmp && !diffs.some((d) => d.key === 'period') && ready.every((x) => x.res.quality.complete && (x.res.series[0].value ?? 0) > 0)
  const idx = (res: ReplayResult) => res.series.map((p) => ((p.value as number) / (res.series[0].value as number)) * 100)
  const all = indexable ? ready.flatMap(({ res }) => idx(res)) : []
  const amounts = (x: ReplayResult, f: (d: ReplayResult['byDenomination'][number]) => number | null, signed = false) => x.byDenomination.map((d) => { const v = f(d); return v == null ? `${d.denomination} unavailable` : signed ? sNative(v, d.denomination, 0) : fmtNative(v, d.denomination, 0) }).join(', ')
  const mark = (ok: boolean | undefined, text: string) => (cmp && !ok ? <span className="t3">{text} (not comparable)</span> : text)
  return (
    <Card id="rp-compare">
      <CardHeader title="Compare replays" sub="Compare up to four replays. Figures are compared only when they’re on the same basis." />
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
              <tr><th scope="row">Positions</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{r.positions.length}</td>)}</tr>
              <tr><th scope="row">Fees</th>{ready.map(({ r }) => <td key={r.key} className="r t2">{feeLabel(r.fees)}</td>)}</tr>
              <tr><th scope="row">Evidence</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{res.quality.complete ? 'Complete' : 'Partial'}</td>)}</tr>
              <tr><th scope="row">Ending value</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{mark(cmp?.amountsComparable, amounts(res, (d) => d.endValue))}</td>)}</tr>
              <tr><th scope="row">Net investment gain</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{mark(cmp?.amountsComparable, amounts(res, (d) => d.netGain, true))}</td>)}</tr>
              <tr><th scope="row">Return</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{res.combined?.ret == null ? 'Unavailable' : mark(cmp?.returnComparable, `${res.combined.ret >= 0 ? '+' : ''}${pct(res.combined.ret * 100)}`)}</td>)}</tr>
              <tr><th scope="row">Realized P&amp;L</th>{ready.map(({ r, res }) => <td key={r.key} className="r">{mark(cmp?.amountsComparable, amounts(res, (d) => d.realizedPnl, true))}</td>)}</tr>
              <tr><th scope="row">Fees</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{amounts(res, (d) => d.fees)}</td>)}</tr>
              <tr><th scope="row">Largest drawdown</th>{ready.map(({ r, res }) => <td key={r.key} className="r t2">{res.drawdown ? mark(cmp?.amountsComparable, kfmt(res.drawdown.amount)) : 'Unavailable'}</td>)}</tr>
            </tbody>
          </table></div>
        )}
        <small className="t3">All replays are hindsight analysis. Current-market scenarios aren’t compared here: a settlement range under outcomes you choose is a different measure from a historical return.</small>
      </div>
    </Card>
  )
}
