/* Scenario Lab entry: choose what to do first. Two starting paths, saved scenarios to resume, optional examples.
   Nothing is created until the user picks something, and no empty charts are shown before there is a portfolio. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Button, PlatformBadge, cx } from '../../components/ui'
import { PLATFORM_NAME } from '../../data/labels'
import { TODAY } from '../../data/portfolio'
import type { Platform } from '../../data/types'
import { ACCOUNTS, POSITIONS, account, fmtDate, validFunding } from '../../lib/finance'
import { fmt } from '../../lib/format'
import { parseMoney } from '../../lib/inputs'
import * as SC from '../../lib/scenarios'
import type { Scenario } from '../../lib/scenarios'
import { EXAMPLES, type Evaluation } from './model'
import { accountName } from '../../lib/useWorkspace'
import { readStored } from '../../lib/storage'
import { sanitizeReplays } from '../../lib/replay'

export function LabHome({ scenarios, evals, onCurrent, onScratch, onOpen, onExample }: {
  scenarios: Scenario[]; evals: Record<string, Evaluation>
  onCurrent: () => void; onScratch: (funding: Partial<Record<Platform, number>>) => void; onOpen: (k: string) => void; onExample: (i: number) => void
}) {
  const nav = useNavigate()
  const replays = readStored('scevia-replays-v1', [], sanitizeReplays)
  const a = account('all'), events = new Set(POSITIONS.map((p) => p.eventId)).size
  const [cap, setCap] = useState<Record<Platform, string>>({ pm: '', ks: '' })
  const parsed = { pm: parseMoney(cap.pm), ks: parseMoney(cap.ks) }
  const bad = (['pm', 'ks'] as Platform[]).some((p) => parsed[p].state === 'invalid' || (parsed[p].state === 'ok' && !validFunding((parsed[p] as { value: number }).value)))
  const funding = Object.fromEntries((['pm', 'ks'] as Platform[]).flatMap((p) => (parsed[p].state === 'ok' && (parsed[p] as { value: number }).value > 0 ? [[p, (parsed[p] as { value: number }).value]] : []))) as Partial<Record<Platform, number>>
  return (
    <div className="lab-home">
      <section className="page-head anchor" id="summary">
        <div><div className="caps"><span className="accent">Scenario Lab</span> · hypothetical portfolios, nothing is traded</div><h1>What do you want to explore?</h1></div>
      </section>

      <div className="start-grid three">
        <section className="start-card" aria-labelledby="start-current">
          <div className="start-ic"><Icon name="layers" size={18} /></div>
          <h2 id="start-current">Modify your current portfolio</h2>
          <p className="t2">Start from what you hold now: resize, exit or add positions in current markets and see what changes.</p>
          <dl className="start-facts">
            <div><dt>Value at marks</dt><dd>{fmt(a.totalValue)}</dd></div>
            <div><dt>Cash</dt><dd>{fmt(a.cash)}</dd></div>
            <div><dt>Positions</dt><dd>{POSITIONS.length} <small className="t3">in {events} events</small></dd></div>
          </dl>
          <div className="start-accts">{ACCOUNTS.map((x) => <span key={x.id} className="row"><PlatformBadge p={x.venue} size={16} />{PLATFORM_NAME[x.venue]} · {accountName(x.id)} · {x.denomination}</span>)}</div>
          <small className="t3">Sample portfolio, reconstructed from records as of {fmtDate(TODAY)}. Prices are frozen when the scenario starts; cash stays in its account. Your actual holdings are never changed.</small>
          <Button variant="primary" icon="layers" onClick={onCurrent}>Modify current portfolio</Button>
        </section>
        <section className="start-card" aria-labelledby="start-scratch">
          <div className="start-ic"><Icon name="plus" size={18} /></div>
          <h2 id="start-scratch">Build from scratch</h2>
          <p className="t2">A hypothetical portfolio with capital you choose. No holdings, cash or history are inherited.</p>
          <fieldset className="setup-f"><legend className="l">Starting capital <span className="t3">(optional, by venue)</span></legend>
            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {(['pm', 'ks'] as Platform[]).map((p) => (
                <label key={p} className={cx('fund', parsed[p].state === 'invalid' && 'has-error')}><PlatformBadge p={p} size={18} />
                  <input className="num-input" inputMode="decimal" placeholder={`${PLATFORM_NAME[p]} ${ACCOUNTS.find((x) => x.venue === p)?.denomination ?? '$'}`} aria-label={`Starting capital on ${PLATFORM_NAME[p]}`} value={cap[p]} aria-invalid={parsed[p].state === 'invalid'} onChange={(e) => setCap((c) => ({ ...c, [p]: e.target.value }))} /></label>
              ))}
            </div>
            <small className={cx(bad ? 'loss' : 't3')}>{bad ? 'Enter amounts such as 5000 or 5,000.50.' : 'You can add or change it later. Cash stays on its venue.'}</small>
          </fieldset>
          <Button icon="plus" disabled={bad} onClick={() => onScratch(funding)}>Build from scratch</Button>
        </section>
        <section className="start-card" aria-labelledby="start-replay">
          <div className="start-ic"><Icon name="clock" size={18} /></div>
          <h2 id="start-replay">Historical replay</h2>
          <p className="t2">Build a hypothetical portfolio over a past period: markets that traded then, entry and exit dates, and the prices you assume.</p>
          <dl className="start-facts">
            <div><dt>Period</dt><dd>Up to today</dd></div>
            <div><dt>Prices</dt><dd>Yours</dd></div>
            <div><dt>Selection</dt><dd>Hindsight</dd></div>
          </dl>
          <small className="t3">Retrospective analysis, not your actual performance and not a test of a strategy you could have followed at the time.</small>
          <Button icon="clock" onClick={() => nav('/scenario-lab/replay?new=1')}>Start a historical replay</Button>
        </section>
      </div>

      <section className="anchor" id="saved" aria-labelledby="saved-h">
        <div className="home-h"><h3 id="saved-h">Your scenarios</h3><small className="t3">{scenarios.length + replays.length ? `${scenarios.length + replays.length} in this session` : ''}</small></div>
        {scenarios.length + replays.length === 0 ? <p className="t3 home-empty">No scenarios yet. They appear here once you start one, and stay in this browser tab.</p> : (
          <div className="scn-cards">
            {scenarios.map((s) => {
              const e = evals[s.key], st = SC.status(s)
              return (
                <button type="button" key={s.key} className="scn-card" onClick={() => onOpen(s.key)} aria-label={`Open ${s.name}`}>
                  <span className="scn-kind">Current market{s.baseAsOf ? ` · prices from ${fmtDate(s.baseAsOf)}` : ''}</span>
                  <span className="row"><i className="sw" style={{ background: s.color }} /><b>{s.name}</b><small className={cx('scn-st', st)}>{st === 'saved' ? 'Saved' : st === 'new' ? 'Not saved' : 'Unsaved changes'}</small></span>
                  <span className="t3">{s.baseline === 'scratch' ? 'From scratch' : 'From current portfolio'} · {s.adjs.length} position{s.adjs.length === 1 ? '' : 's'}{e.funding ? ` · +${fmt(e.funding)} capital` : ''}</span>
                  <span className="scn-v">{e.A.totalValue == null ? <span className="t3">Value unavailable</span> : fmt(e.A.totalValue)}<small className="t3"> at marks{Object.keys(e.sim.errors).length ? ' · incomplete' : ''}{e.A.shortfall > 0 ? ' · needs funding' : ''}</small></span>
                </button>
              )
            })}
            {replays.map((r) => (
              <button type="button" key={r.key} className="scn-card" onClick={() => nav(`/scenario-lab/replay?open=${encodeURIComponent(r.key)}`)} aria-label={`Open ${r.name}`}>
                <span className="scn-kind">Historical replay · hindsight</span>
                <span className="row"><i className="sw" style={{ background: r.color }} /><b>{r.name}</b></span>
                <span className="t3">{fmtDate(r.start, { month: 'short', day: 'numeric', year: 'numeric' })} – {fmtDate(r.end, { month: 'short', day: 'numeric', year: 'numeric' })} · {r.positions.length} position{r.positions.length === 1 ? '' : 's'}</span>
                <span className="scn-v t3">Open to analyze</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="home-ex" aria-labelledby="ex-h">
        <h3 id="ex-h" className="caps">Or explore an example</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>{EXAMPLES.map((ex, i) => <Button key={ex.name} size="sm" variant="ghost" icon="flask" onClick={() => onExample(i)}>{ex.name}</Button>)}</div>
        <small className="t3">Examples start from your current portfolio and are only added if you open one.</small>
      </section>
      <div className="footer-note"><span>Scenario results show what happens under the outcomes and prices you choose. They aren’t forecasts or recommendations.</span><span>Sample portfolio · sample market data</span></div>
    </div>
  )
}
