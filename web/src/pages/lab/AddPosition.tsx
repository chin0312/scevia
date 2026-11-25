/* Add a position to a scenario: from your holdings, by searching markets, or by pasting a supported market link.
   Nothing is traded or stored as a holding; the result is a hypothetical row in the scenario's portfolio. */
import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/overlays'
import { Button, Callout, Chip, PlatformBadge, Seg, SideChip, Tabs, cx } from '../../components/ui'
import { MARKET_CATALOG } from '../../data/markets'
import { PLATFORM_NAME } from '../../data/labels'
import type { Platform } from '../../data/types'
import { POSITIONS, fmtDate, instrumentKey, instrumentOfPosition, type Adjustment, type Baseline, type InstrumentRef } from '../../lib/finance'
import { int } from '../../lib/format'
import { instrumentFrom, type CatalogEvent, type LinkResolution } from '../../lib/markets'
import { positionFor } from './model'

type Source = 'Your holdings' | 'Search markets' | 'Paste link'

/** Turn a chosen instrument into a scenario row. Identity is provider + market + outcome: the same contract you hold
 *  maps to your position (in a current-portfolio scenario it starts at its current size: no trade); any other
 *  contract, including one on the same event, is a new instrument from zero with no quantity or price filled in. */
export function rowFor(i: InstrumentRef, baseline: Baseline): Adjustment {
  const p = positionFor(i)
  if (p && baseline === 'portfolio') return { id: p.id, to: p.shares, price: p.mark, instrument: instrumentOfPosition(p) }
  return { id: p ? p.id : instrumentKey(i), to: null, price: null, instrument: i }
}

export function AddPositionModal({ baseline, present, onAdd, onClose }: { baseline: Baseline; present: Set<string>; onAdd: (a: Adjustment) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Source>('Your holdings')
  const has = (i: InstrumentRef) => present.has(rowFor(i, baseline).id)
  const add = (i: InstrumentRef) => { onAdd(rowFor(i, baseline)); onClose() }
  return (
    <Modal title="Add a position" sub="Hypothetical only: nothing is traded and your actual holdings don’t change" onClose={onClose} width={640}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <Tabs label="Add from" options={['Your holdings', 'Search markets', 'Paste link'] as const} value={tab} onChange={setTab} />
      <div className="addpos">
        {tab === 'Your holdings' && <Holdings baseline={baseline} has={has} add={add} />}
        {tab === 'Search markets' && <Search has={has} add={add} />}
        {tab === 'Paste link' && <PasteLink has={has} add={add} />}
      </div>
    </Modal>
  )
}

function Holdings({ baseline, has, add }: { baseline: Baseline; has: (i: InstrumentRef) => boolean; add: (i: InstrumentRef) => void }) {
  const [q, setQ] = useState('')
  const list = POSITIONS.filter((p) => !q.trim() || p.market.toLowerCase().includes(q.trim().toLowerCase()))
  return (<>
    <input data-autofocus className="text-input" type="search" placeholder="Filter your holdings" aria-label="Filter your holdings" value={q} onChange={(e) => setQ(e.target.value)} />
    {baseline === 'scratch' && <p className="t3 note">This scenario starts from an empty portfolio, so a holding is added as a new position from zero.</p>}
    <div className="addpos-list" role="list">
      {list.length === 0 && <div className="empty"><p>No holdings match “{q}”.</p></div>}
      {list.map((p) => {
        const i = instrumentOfPosition(p), inScenario = has(i)
        return (
          <div className="addpos-item" role="listitem" key={p.id}>
            <PlatformBadge p={p.platform} />
            <span className="addpos-t"><b>{p.market}</b><small className="t3"><SideChip side={p.side} /> {int(p.shares)} shares · mark {p.mark.toFixed(2)} · {PLATFORM_NAME[p.platform]}</small></span>
            <Button size="sm" disabled={inScenario} onClick={() => add(i)} aria-label={`Add ${p.market} ${p.side}`}>{inScenario ? 'In scenario' : 'Add'}</Button>
          </div>
        )
      })}
    </div>
  </>)
}

function Search({ has, add }: { has: (i: InstrumentRef) => boolean; add: (i: InstrumentRef) => void }) {
  const [q, setQ] = useState('')
  const [prov, setProv] = useState<'All' | 'Polymarket' | 'Kalshi'>('All')
  const [res, setRes] = useState<{ q: string; events: CatalogEvent[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current, provider: Platform | undefined = prov === 'Polymarket' ? 'pm' : prov === 'Kalshi' ? 'ks' : undefined
    setLoading(true)
    const t = window.setTimeout(() => { MARKET_CATALOG.search(q, { provider }).then((events) => { if (n === seq.current) { setRes({ q, events }); setLoading(false) } }) }, 150)
    return () => window.clearTimeout(t)
  }, [q, prov])
  return (<>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <input data-autofocus className="text-input" style={{ flex: 1, minWidth: 200 }} type="search" placeholder="Search markets, e.g. “Fed” or “Ethereum”" aria-label="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
      <Seg label="Provider" options={['All', 'Polymarket', 'Kalshi'] as const} value={prov} onChange={setProv} />
    </div>
    <p className="t3 note"><Chip tone="warn">{MARKET_CATALOG.label}</Chip> Fictional markets with sample reference prices, not live quotes.</p>
    <div className="addpos-list" aria-busy={loading} aria-live="polite">
      {loading && !res && <div className="skeleton" style={{ height: 120 }} />}
      {res && res.events.length === 0 && <div className="empty"><p>No markets match “{res.q}”.</p></div>}
      {res?.events.map((ev) => <EventCard key={ev.eventId} ev={ev} has={has} add={add} />)}
    </div>
  </>)
}

function PasteLink({ has, add }: { has: (i: InstrumentRef) => boolean; add: (i: InstrumentRef) => void }) {
  const [url, setUrl] = useState('')
  const [state, setState] = useState<{ loading: boolean; res: LinkResolution | null }>({ loading: false, res: null })
  const resolve = async () => {
    if (!url.trim()) return
    setState({ loading: true, res: null })
    const res = await MARKET_CATALOG.resolveLink(url)
    setState({ loading: false, res })
  }
  const r = state.res
  return (<>
    <form className="row" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void resolve() }}>
      <input data-autofocus className="text-input" style={{ flex: 1, minWidth: 220 }} inputMode="url" placeholder="https://polymarket.com/event/… or https://kalshi.com/markets/…" aria-label="Market link" value={url} onChange={(e) => { setUrl(e.target.value); setState({ loading: false, res: null }) }} />
      <Button type="submit" disabled={!url.trim() || state.loading}>{state.loading ? 'Resolving…' : 'Find market'}</Button>
    </form>
    <p className="t3 note">Supported: Polymarket and Kalshi market links. Scevia doesn’t open the link; it looks up the market reference. {MARKET_CATALOG.live ? '' : `In this version, links resolve only against the ${MARKET_CATALOG.label.toLowerCase()}.`}</p>
    <div aria-live="polite">
      {state.loading && <div className="skeleton" style={{ height: 80 }} />}
      {r?.status === 'invalid' && <Callout tone="warn" icon="alert">{r.message}</Callout>}
      {r?.status === 'unsupported' && <Callout tone="warn" icon="alert">Links from {r.host} aren’t supported. Use a Polymarket or Kalshi market link.</Callout>}
      {r?.status === 'not-found' && <Callout icon="info">No {PLATFORM_NAME[r.provider]} market for this link in the {MARKET_CATALOG.label.toLowerCase()}. {MARKET_CATALOG.live ? '' : 'Live link lookup isn’t connected in this version, so real links aren’t resolved.'}</Callout>}
      {r?.status === 'unavailable' && <Callout tone="warn" icon="alert">{r.eventTitle} on {PLATFORM_NAME[r.provider]}: market data is unavailable, so it can’t be added.</Callout>}
      {r?.status === 'resolved' && <>
        <p className="t2 note">{r.event.markets.length > 1 ? `This link covers ${r.event.markets.length} markets. Choose the market and outcome to add.` : 'Choose the outcome to add.'} <Chip tone="warn">{MARKET_CATALOG.label}</Chip></p>
        <EventCard ev={r.event} has={has} add={add} />
      </>}
    </div>
  </>)
}

/** One event with its markets and selectable outcomes. Closed or resolved markets can't be added. */
function EventCard({ ev, has, add }: { ev: CatalogEvent; has: (i: InstrumentRef) => boolean; add: (i: InstrumentRef) => void }) {
  return (
    <div className="addpos-event">
      <div className="row"><PlatformBadge p={ev.provider} /><b>{ev.eventTitle}</b></div>
      {ev.markets.map((m) => (
        <div className="addpos-market" key={m.marketId}>
          <div className="addpos-t"><span>{m.marketTitle}</span>
            <small className="t3">{m.category} · resolves {fmtDate(m.resolves, { month: 'short', day: 'numeric', year: 'numeric' })} · {m.status === 'open' ? (m.refAsOf ? `sample prices as of ${fmtDate(m.refAsOf)}` : 'no reference price') : m.status}</small></div>
          <div className="addpos-outcomes">
            {m.outcomes.map((o) => {
              const i = instrumentFrom(ev, m, o, MARKET_CATALOG.live ? 'provider' : 'sample'), inScenario = has(i), closed = m.status !== 'open'
              return (
                <button type="button" key={o.outcome} className={cx('outcome-btn', o.outcome === 'YES' ? 'yes' : 'no')} disabled={closed || inScenario}
                  aria-label={`Add ${m.marketTitle} ${o.outcome}${o.refPrice != null ? ` at reference ${o.refPrice.toFixed(2)}` : ''}`} onClick={() => add(i)}
                  title={closed ? `This market is ${m.status}` : inScenario ? 'Already in this scenario' : undefined}>
                  <b>{o.outcome}</b><span>{inScenario ? 'in scenario' : o.refPrice != null ? o.refPrice.toFixed(2) : 'no price'}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
