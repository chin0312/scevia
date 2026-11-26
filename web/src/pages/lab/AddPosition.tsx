/* Add markets to a scenario: pick several instruments from your holdings, market search or a supported link, review
   the selection, then add them together. Each pick is one explicit outcome of one market; nothing is added for a
   whole event. Nothing is traded or stored as a holding: the result is hypothetical rows in the scenario. */
import { useEffect, useRef, useState } from 'react'
import { useMarketCatalog } from '../../lib/marketContext'
import { assetLabel } from '../../lib/fx'
import { evidenceOf, type CatalogMarket } from '../../lib/markets'
import { Modal } from '../../components/overlays'
import { Button, Callout, Chip, PlatformBadge, Seg, SideChip, Tabs, cx } from '../../components/ui'
import { CATEGORIES, PLATFORM_NAME } from '../../data/labels'
import type { Category, Platform } from '../../data/types'
import { fmtDate, instrumentKey, type Adjustment, type Baseline, type InstrumentRef, type Position, type Finance } from '../../lib/finance'
import { qty } from '../../lib/format'
import { instrumentFrom, type CatalogEvent, type LinkResolution } from '../../lib/markets'
import { accountName } from '../../lib/useWorkspace'
import { useFinance } from '../../lib/financeContext'

type Source = 'Your holdings' | 'Search markets' | 'Paste link'
/** One pick: an instrument, and the actual holding it refers to when picked from your holdings (account-specific). */
interface Pick { key: string; i: InstrumentRef; held: Position | null }

/** Turn a pick into a scenario row. A pick from your holdings refers to that account's position: in a current-portfolio
 *  scenario it starts at its current size (no trade); from scratch it starts from zero with no quantity. A searched
 *  instrument that exactly one account holds maps to that holding; when several accounts hold it, it is added as a
 *  new purchase (choose the account under "Your holdings" to change an existing one). Nothing is pre-filled for new
 *  instruments. */
export function rowFor(F: { holdingsOfInstrument: Finance['holdingsOfInstrument']; instrumentOfPosition: Finance['instrumentOfPosition'] }, i: InstrumentRef, baseline: Baseline, held?: Position | null): Adjustment {
  const hs = held ? [held] : F.holdingsOfInstrument(i)
  const p = hs.length === 1 ? hs[0] : null
  if (p && baseline === 'portfolio') return { id: p.id, to: p.shares, price: p.mark, instrument: F.instrumentOfPosition(p) }
  return { id: p ? p.id : instrumentKey(i), to: null, price: null, instrument: i }
}

export function AddPositionModal({ baseline, present, onAdd, onClose }: { baseline: Baseline; present: Set<string>; onAdd: (a: Adjustment[]) => void; onClose: () => void }) {
  const Fin = useFinance()
  const [tab, setTab] = useState<Source>(baseline === 'scratch' ? 'Search markets' : 'Your holdings')
  const [picked, setPicked] = useState<Pick[]>([])
  const idOf = (p: Pick) => rowFor(Fin, p.i, baseline, p.held).id
  const inScenario = (p: Pick) => present.has(idOf(p))
  // The same scenario row can be reached from your holdings or from search: it is one selection either way.
  const same = (x: Pick, p: Pick) => x.key === p.key || idOf(x) === idOf(p)
  const isPicked = (p: Pick) => picked.some((x) => same(x, p))
  const toggle = (p: Pick) => setPicked((xs) => (xs.some((x) => same(x, p)) ? xs.filter((x) => !same(x, p)) : [...xs, p]))
  const add = () => { onAdd(picked.filter((p) => !inScenario(p)).map((p) => rowFor(Fin, p.i, baseline, p.held))); onClose() }
  return (
    <Modal title="Add markets" sub="Pick one or more outcomes, then add them together." onClose={onClose} width={720}
      footer={<div className="addpos-foot">
        <div className="addpos-basket" aria-live="polite">
          {picked.length === 0 ? <span className="t3">Nothing selected yet</span> : picked.map((p) => (
            <span key={p.key} className="basket-chip"><PlatformBadge p={p.i.provider} size={16} /><span className="bc-t">{p.i.marketTitle}</span><SideChip side={p.i.outcome} />
              <button type="button" className="icon-btn" aria-label={`Remove ${p.i.marketTitle} ${p.i.outcome} from selection`} onClick={() => toggle(p)}>×</button></span>
          ))}
        </div>
        <div className="row"><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picked.length === 0} onClick={add}>{picked.length ? `Add ${picked.length} position${picked.length > 1 ? 's' : ''}` : 'Add positions'}</Button></div>
      </div>}>
      <Tabs label="Add from" options={['Your holdings', 'Search markets', 'Paste link'] as const} value={tab} onChange={setTab} />
      <div className="addpos">
        {tab === 'Your holdings' && <Holdings baseline={baseline} inScenario={inScenario} isPicked={isPicked} toggle={toggle} />}
        {tab === 'Search markets' && <Search inScenario={inScenario} isPicked={isPicked} toggle={toggle} />}
        {tab === 'Paste link' && <PasteLink inScenario={inScenario} isPicked={isPicked} toggle={toggle} />}
      </div>
    </Modal>
  )
}

interface PickProps { inScenario: (p: Pick) => boolean; isPicked: (p: Pick) => boolean; toggle: (p: Pick) => void }

function Holdings({ baseline, inScenario, isPicked, toggle }: PickProps & { baseline: Baseline }) {
  const { POSITIONS, instrumentOfPosition } = useFinance()
  const [q, setQ] = useState('')
  const list = POSITIONS.filter((p) => !q.trim() || p.market.toLowerCase().includes(q.trim().toLowerCase()))
  const picks = list.map((p): Pick => ({ key: `held:${p.id}`, i: instrumentOfPosition(p), held: p }))
  const free = picks.filter((p) => !inScenario(p))
  const allOn = free.length > 0 && free.every((p) => isPicked(p))
  return (<>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <input data-autofocus autoFocus className="text-input" style={{ flex: 1, minWidth: 200 }} type="search" placeholder="Filter your holdings" aria-label="Filter your holdings" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="button" className="link" disabled={!free.length} onClick={() => free.forEach((p) => { if (isPicked(p) === allOn) toggle(p) })}>{allOn ? 'Clear these' : `Select all ${free.length}`}</button>
    </div>
    {baseline === 'scratch' && <p className="t3 note">This scenario starts from an empty portfolio: a holding is added from zero, and your actual quantity is not copied.</p>}
    <div className="addpos-list" role="list">
      {list.length === 0 && <div className="empty"><p>No holdings match “{q}”.</p></div>}
      {picks.map((pk) => {
        const p = pk.held!, already = inScenario(pk), on = isPicked(pk)
        return (
          <label className={cx('addpos-item', 'pickable', on && 'on', already && 'is-disabled')} role="listitem" key={pk.key}>
            <input type="checkbox" checked={already || on} disabled={already} onChange={() => toggle(pk)} aria-label={`Select ${p.market} ${p.side}`} />
            <PlatformBadge p={p.platform} />
            <span className="addpos-t"><b>{p.market}</b><small className="t3"><SideChip side={p.side} /> {qty(p.shares)} shares at {p.mark.toFixed(2)}, {accountName(p.accountId)} on {PLATFORM_NAME[p.platform]}</small></span>
            <small className="t3">{already ? 'In scenario' : ''}</small>
          </label>
        )
      })}
    </div>
  </>)
}

const CATS = ['All categories', ...CATEGORIES] as const
function Search({ inScenario, isPicked, toggle }: PickProps) {
  const MARKET_CATALOG = useMarketCatalog()
  const [q, setQ] = useState('')
  const [prov, setProv] = useState<'All' | 'Polymarket' | 'Kalshi'>('All')
  const [cat, setCat] = useState<(typeof CATS)[number]>('All categories')
  const [openOnly, setOpenOnly] = useState(true)
  const [pricedOnly, setPricedOnly] = useState(false)
  // Results are keyed by the request that produced them; only results for the current query and provider are shown.
  const [state, setState] = useState<{ q: string; prov: string; events: CatalogEvent[] } | { q: string; prov: string; error: true } | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current, provider: Platform | undefined = prov === 'Polymarket' ? 'pm' : prov === 'Kalshi' ? 'ks' : undefined
    setLoading(true)
    // Only the latest request may update the list (stale responses are dropped); a failure is shown, never an empty list.
    const t = window.setTimeout(() => {
      MARKET_CATALOG.search(q, { provider })
        .then((events) => { if (n === seq.current) { setState({ q, prov, events }); setLoading(false) } })
        .catch(() => { if (n === seq.current) { setState({ q, prov, error: true }); setLoading(false) } })
    }, 150)
    return () => window.clearTimeout(t)
  }, [q, prov, retry, MARKET_CATALOG])
  // A closed dialog (or another service) can't receive an obsolete response.
  useEffect(() => () => { seq.current++ }, [])
  const current = !!state && state.q === q && state.prov === prov
  const events = current && state && 'events' in state ? state.events.map((ev) => ({ ...ev, markets: ev.markets.filter((m) => (cat === 'All categories' || m.category === (cat as Category)) && (!openOnly || m.status === 'open') && (!pricedOnly || m.outcomes.some((o) => o.refPrice != null))) })).filter((ev) => ev.markets.length) : []
  return (<>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <input data-autofocus autoFocus className="text-input" style={{ flex: 1, minWidth: 200 }} type="search" placeholder="Search markets, e.g. “Fed” or “Ethereum”" aria-label="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
      <Seg label="Provider" options={['All', 'Polymarket', 'Kalshi'] as const} value={prov} onChange={setProv} />
    </div>
    <div className="row search-filters" style={{ flexWrap: 'wrap' }}>
      <select className="select" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value as (typeof CATS)[number])}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
      <label className="check"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />Open markets only</label>
      <label className="check"><input type="checkbox" checked={pricedOnly} onChange={(e) => setPricedOnly(e.target.checked)} />With a reference price</label>
      <Chip tone="warn">{MARKET_CATALOG.label}</Chip>
    </div>
    <div className="addpos-list" aria-busy={loading} aria-live="polite">
      {(loading || !current) && <small className="t3" role="status">Searching{q.trim() ? ` for “${q.trim()}”` : ''}…</small>}
      {!current && <div className="skeleton" style={{ height: 120 }} />}
      {current && state && 'error' in state && <Callout tone="warn" icon="alert">Market search isn’t available right now. Your scenario is unaffected and nothing is shown in its place. <button type="button" className="link" onClick={() => setRetry((r) => r + 1)}>Try again</button></Callout>}
      {current && state && 'events' in state && events.length === 0 && <div className="empty"><p>No markets match{state.q ? ` “${state.q}”` : ''} with these filters.</p></div>}
      {events.map((ev) => <EventCard key={ev.eventId} ev={ev} inScenario={inScenario} isPicked={isPicked} toggle={toggle} />)}
    </div>
  </>)
}

function PasteLink({ inScenario, isPicked, toggle }: PickProps) {
  const MARKET_CATALOG = useMarketCatalog()
  const [url, setUrl] = useState('')
  const [state, setState] = useState<{ loading: boolean; res: LinkResolution | null; failed?: boolean }>({ loading: false, res: null })
  const seq = useRef(0)
  const resolve = async () => {
    if (!url.trim()) return
    const n = ++seq.current
    setState({ loading: true, res: null })
    try {
      const res = await MARKET_CATALOG.resolveLink(url)
      if (n === seq.current) setState({ loading: false, res })
    } catch { if (n === seq.current) setState({ loading: false, res: null, failed: true }) }
  }
  const r = state.res
  return (<>
    <form className="row" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void resolve() }}>
      <input data-autofocus autoFocus className="text-input" style={{ flex: 1, minWidth: 220 }} inputMode="url" placeholder="Market link, or a Polymarket / Kalshi market id" aria-label="Market link" value={url} onChange={(e) => { setUrl(e.target.value); seq.current++; setState({ loading: false, res: null }) }} />
      <Button type="submit" disabled={!url.trim() || state.loading}>{state.loading ? 'Resolving market…' : 'Find market'}</Button>
    </form>
    <p className="t3 note">Supported: Polymarket and Kalshi market links. Scevia doesn’t open the link; it looks up the market reference. {MARKET_CATALOG.live ? '' : `In this version, links resolve only against the ${MARKET_CATALOG.label.toLowerCase()}.`}</p>
    <div aria-live="polite">
      {state.loading && <div className="skeleton" style={{ height: 80 }} />}
      {state.failed && <Callout tone="warn" icon="alert">The link couldn’t be looked up. <button type="button" className="link" onClick={() => void resolve()}>Try again</button></Callout>}
      {r?.status === 'invalid' && <Callout tone="warn" icon="alert">{r.message}</Callout>}
      {r?.status === 'unsupported' && <Callout tone="warn" icon="alert">Links from {r.host} aren’t supported. Use a Polymarket or Kalshi market link.</Callout>}
      {r?.status === 'not-found' && <Callout icon="info">No {PLATFORM_NAME[r.provider]} market for this link in the {MARKET_CATALOG.label.toLowerCase()}. {MARKET_CATALOG.live ? '' : 'Live link lookup isn’t connected in this version, so real links aren’t resolved.'}</Callout>}
      {r?.status === 'unavailable' && <Callout tone="warn" icon="alert">{r.eventTitle} on {PLATFORM_NAME[r.provider]}: market data is unavailable, so it can’t be added.</Callout>}
      {r?.status === 'unsupported-market' && <Callout tone="warn" icon="alert">This {PLATFORM_NAME[r.provider]} market type isn’t supported: {r.reason}</Callout>}
      {(r?.status === 'temporarily-unavailable' || r?.status === 'access-unavailable') && <Callout tone="warn" icon="alert">{r.status === 'temporarily-unavailable' ? 'Market data is temporarily unavailable for this link.' : 'Market data access isn’t available for this link.'} Nothing is shown in its place. <button type="button" className="link" onClick={() => void resolve()}>Try again</button></Callout>}
      {r?.status === 'resolved' && <>
        <p className="t2 note">{r.event.markets.length > 1 ? `This link covers ${r.event.markets.length} markets. Choose the markets and outcomes to add.` : 'Choose the outcome to add.'} <Chip tone="warn">{MARKET_CATALOG.label}</Chip></p>
        <EventCard ev={r.event} inScenario={inScenario} isPicked={isPicked} toggle={toggle} />
      </>}
    </div>
  </>)
}

/** One event with its markets and selectable outcomes. Closed or resolved markets can't be added. */
function EventCard({ ev, inScenario, isPicked, toggle }: PickProps & { ev: CatalogEvent }) {
  const MARKET_CATALOG = useMarketCatalog()
  const { holdingsOfInstrument } = useFinance()
  return (
    <div className="addpos-event">
      <div className="row"><PlatformBadge p={ev.provider} /><b>{ev.eventTitle}</b>{ev.markets.length > 1 && <small className="t3">{ev.markets.length} markets, pick any</small>}</div>
      {ev.markets.map((m) => (
        <div className="addpos-market" key={m.marketId}>
          <div className="addpos-t"><span>{m.marketTitle}</span>
            <small className="t3">{PLATFORM_NAME[m.provider]}{m.denomination ? `, settles in ${assetLabel(m.denomination)}` : ''}. Resolves {fmtDate(m.resolves, { month: 'short', day: 'numeric', year: 'numeric' })}. {m.status === 'open' ? (m.refAsOf ? `Price as of ${fmtDate(m.refAsOf)}` : 'No price yet') : m.status === 'closed' ? 'Trading closed' : 'Resolved'}</small>
            <EvidenceBadges m={m} /></div>
          <div className="addpos-outcomes">
            {m.outcomes.map((o) => {
              const i = instrumentFrom(ev, m, o, MARKET_CATALOG.live ? 'provider' : 'sample'), pk: Pick = { key: instrumentKey(i), i, held: null }
              const already = inScenario(pk), on = isPicked(pk), closed = m.status !== 'open', several = holdingsOfInstrument(i).length > 1
              return (
                <button type="button" key={o.outcome} className={cx('outcome-btn', o.outcome === 'YES' ? 'yes' : 'no', on && 'on')} disabled={closed || already} aria-pressed={on}
                  aria-label={`${on ? 'Deselect' : 'Select'} ${m.marketTitle} ${o.outcome}${o.refPrice != null ? ` at reference ${o.refPrice.toFixed(2)}` : ''}`} onClick={() => toggle(pk)}
                  title={closed ? `This market is ${m.status}` : already ? 'Already in this scenario' : several ? 'Held in several accounts: added as a new purchase. Pick the account under “Your holdings” to change one.' : undefined}>
                  <b>{o.outcome}</b><span>{already ? 'in scenario' : on ? 'selected' : o.refPrice != null ? o.refPrice.toFixed(2) : 'no price'}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** What the market service has for a market. Finding a market and pricing it are different: a found market can lack a
 *  price, history, fee or resolution evidence, and each missing part stays visible instead of failing the search. */
export function EvidenceBadges({ m }: { m: CatalogMarket }) {
  const e = evidenceOf(m)
  const items: [string, string][] = [['Price', e.price], ['History', e.history], ['Fees', e.fee], ['Resolution', e.resolution]]
  return (
    <span className="ev-badges" aria-label="Evidence">
      {items.filter(([k, v]) => !(k === 'Resolution' && v === 'not-resolved')).map(([k, v]) => <span key={k} className={cx('ev-b', v)}>{k}: {v === 'available' ? 'yes' : v === 'partial' ? 'partial' : v === 'loading' ? 'loading…' : 'none'}</span>)}
    </span>
  )
}
