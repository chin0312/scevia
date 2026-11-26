/* Scenario Lab entry: choose what to do first. Two starting paths, saved scenarios to resume, optional examples.
   Nothing is created until the user picks something, and no empty charts are shown before there is a portfolio. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Button, Chip, PlatformBadge, cx } from '../../components/ui'
import { MarketDataLabel } from '../../components/Workspace'
import { count } from '../../lib/text'
import { PLATFORM_NAME } from '../../data/labels'
import type { Platform } from '../../data/types'
import { fmtDate, validFunding } from '../../lib/finance'
import { fmt } from '../../lib/format'
import { parseMoney } from '../../lib/inputs'
import * as SC from '../../lib/scenarios'
import type { Scenario } from '../../lib/scenarios'
import { EXAMPLES, type Evaluation } from './model'
import { accountName } from '../../lib/useWorkspace'
import { readStored, scopedKey } from '../../lib/storage'
import { useFinanceCtx } from '../../lib/financeContext'
import { DEFAULT_ASSET, sanitizeReplays } from '../../lib/replay'
import { LAB_REPLAYS_KEY, mergeByKey } from './baseline'
import { useFinance } from '../../lib/financeContext'
import { useActiveWorkspace } from '../../lib/workspaceContext'

export function LabHome({ hasPortfolio, scenarios, evals, onCurrent, onScratch, onOpen, onExample }: {
  hasPortfolio: boolean; scenarios: Scenario[]; evals: Record<string, Evaluation>
  onCurrent: () => void; onScratch: (funding: Partial<Record<Platform, number>>) => void; onOpen: (k: string) => void; onExample: (i: number) => void
}) {
  const F = useFinance(), { TODAY, ACCOUNTS, POSITIONS, account } = F
  const nav = useNavigate()
  const ws = useActiveWorkspace().snapshot
  const replays = mergeByKey(readStored(LAB_REPLAYS_KEY, [], sanitizeReplays), readStored(scopedKey('scevia-replays-v1', useFinanceCtx().workspaceId), [], sanitizeReplays))
  const a = account('all'), events = new Set(POSITIONS.map((p) => p.eventId)).size
  const [cap, setCap] = useState<Record<Platform, string>>({ pm: '', ks: '' })
  const parsed = { pm: parseMoney(cap.pm), ks: parseMoney(cap.ks) }
  const bad = (['pm', 'ks'] as Platform[]).some((p) => parsed[p].state === 'invalid' || (parsed[p].state === 'ok' && !validFunding((parsed[p] as { value: number }).value)))
  const funding = Object.fromEntries((['pm', 'ks'] as Platform[]).flatMap((p) => (parsed[p].state === 'ok' && (parsed[p] as { value: number }).value > 0 ? [[p, (parsed[p] as { value: number }).value]] : []))) as Partial<Record<Platform, number>>
  return (
    <div className="lab-home">
      <section className="page-head anchor" id="summary">
        <div><div className="head-row"><h1>Scenario Lab</h1><MarketDataLabel /></div><p className="t2 lab-intro">Build, analyze and compare hypothetical portfolios.</p></div>
      </section>

      <div className="start-grid three">
        <section className="start-card" aria-labelledby="start-current">
          <div className="start-ic"><Icon name="layers" size={18} /></div>
          <h2 id="start-current">Modify your current portfolio</h2>
          <p className="t2">Adjust existing positions and see how the changes affect your portfolio.</p>
          {hasPortfolio ? <>
          <dl className="start-facts">
            <div><dt>Portfolio value</dt><dd>{fmt(a.totalValue)}</dd></div>
            <div><dt>Cash</dt><dd>{fmt(a.cash)}</dd></div>
            <div><dt>Positions</dt><dd>{POSITIONS.length}{' '}<small className="t3">in {count(events, 'event')}</small></dd></div>
          </dl>
          <div className="start-accts">{ACCOUNTS.map((x) => <span key={x.id} className="row"><PlatformBadge p={x.venue} size={16} />{accountName(x.id)} on {PLATFORM_NAME[x.venue]}</span>)}</div>
          <small className="t3">Holdings as of {fmtDate(TODAY)}</small>
          </> : <p className="unavailable" role="status">{ws.status === 'loading' ? `${ws.summary.name} is still loading.` : `${ws.summary.name} has no portfolio data right now.`} Build from scratch and Historical Replay don’t need a portfolio.</p>}
          <Button variant="primary" icon="layers" onClick={onCurrent} disabled={!hasPortfolio}>Modify current portfolio</Button>
        </section>
        <section className="start-card" aria-labelledby="start-scratch">
          <div className="start-ic"><Icon name="plus" size={18} /></div>
          <h2 id="start-scratch">Build from scratch</h2>
          <p className="t2">Create a hypothetical portfolio with virtual funds.</p>
          <fieldset className="setup-f"><legend className="l">Starting capital <span className="t3">(optional)</span></legend>
            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {(['pm', 'ks'] as Platform[]).map((p) => (
                <label key={p} className={cx('fund', parsed[p].state === 'invalid' && 'has-error')}><PlatformBadge p={p} size={18} />
                  <input className="num-input" inputMode="decimal" placeholder={`${PLATFORM_NAME[p]} ${DEFAULT_ASSET[p]}`} aria-label={`Starting capital on ${PLATFORM_NAME[p]}`} value={cap[p]} aria-invalid={parsed[p].state === 'invalid'} onChange={(e) => setCap((c) => ({ ...c, [p]: e.target.value }))} /></label>
              ))}
            </div>
            {bad && <small className="loss">Enter amounts such as 5000 or 5,000.50.</small>}
          </fieldset>
          <Button icon="plus" disabled={bad} onClick={() => onScratch(funding)}>Build from scratch</Button>
        </section>
        <section className="start-card" aria-labelledby="start-replay">
          <div className="start-ic"><Icon name="clock" size={18} /></div>
          <h2 id="start-replay">Historical Replay</h2>
          <p className="t2">Test hypothetical trades against past markets and their recorded outcomes.</p>
          <dl className="start-facts">
            <div><dt>Starting capital</dt><dd>Virtual funds</dd></div>
            <div><dt>Entry and exit prices</dt><dd>Set by you</dd></div>
            <div><dt>Outcomes</dt><dd>Historical</dd></div>
          </dl>
          <Button icon="clock" onClick={() => nav('/scenario-lab/replay?new=1')}>Start Historical Replay</Button>
        </section>
      </div>

      <section className="anchor" id="saved" aria-labelledby="saved-h">
        <div className="home-h"><h3 id="saved-h">Your scenarios</h3>{scenarios.length + replays.length > 0 && <small className="t3">{scenarios.length + replays.length} in this browser tab</small>}</div>
        {scenarios.length + replays.length === 0 ? <p className="t3 home-empty">No scenarios yet.</p> : (
          <div className="scn-cards">
            {scenarios.map((s) => {
              const e = evals[s.key], st = SC.status(s)
              const noStart = s.baseline === 'portfolio' && !s.frozen
              const flags = noStart ? [] : [Object.keys(e.sim.errors).length > 0 && 'Incomplete inputs', e.A.shortfall > 0 && 'Needs funding'].filter((x): x is string => !!x)
              return (
                <button type="button" key={s.key} className="scn-card" onClick={() => onOpen(s.key)} aria-label={`Open ${s.name}`}>
                  <span className="scn-kind">{s.baseline === 'scratch' ? 'Starts empty' : `From ${s.source?.name ?? 'a portfolio'}${s.frozen ? `, ${fmtDate(s.frozen.asOf)}` : ''}`}</span>
                  <span className="row"><i className="sw" style={{ background: s.color }} /><b>{s.name}</b><small className={cx('scn-st', st)}>{st === 'saved' ? 'Saved' : st === 'new' ? 'Not saved' : 'Unsaved changes'}</small></span>
                  <span className="t3">{count(s.adjs.length, 'position')}{e.funding ? `, ${fmt(e.funding)} added capital` : ''}</span>
                  <span className="scn-v">{noStart ? <span className="t3">Starting portfolio unavailable</span> : e.A.totalValue == null ? <span className="t3">Value unavailable</span> : <>{fmt(e.A.totalValue)}{' '}<small className="t3">portfolio value</small></>}</span>
                  {flags.length > 0 && <span className="scn-flags">{flags.map((f) => <Chip key={f} tone="warn">{f}</Chip>)}</span>}
                </button>
              )
            })}
            {replays.map((r) => (
              <button type="button" key={r.key} className="scn-card" onClick={() => nav(`/scenario-lab/replay?open=${encodeURIComponent(r.key)}`)} aria-label={`Open ${r.name}`}>
                <span className="scn-kind">Historical Replay</span>
                <span className="row"><i className="sw" style={{ background: r.color }} /><b>{r.name}</b></span>
                <span className="t3">{fmtDate(r.start, { month: 'short', day: 'numeric', year: 'numeric' })} – {fmtDate(r.end, { month: 'short', day: 'numeric', year: 'numeric' })}, {count(r.positions.length, 'position')}</span>
                <span className="scn-v t3">Open to analyze</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {EXAMPLES.some((ex) => ex.adjs(F)) && <section className="home-ex" aria-labelledby="ex-h">
        <h3 id="ex-h" className="caps">Or explore an example</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>{EXAMPLES.map((ex, i) => ex.adjs(F) && <Button key={ex.name} size="sm" variant="ghost" icon="flask" onClick={() => onExample(i)}>{ex.name}</Button>)}</div>
      </section>}
    </div>
  )
}
