/* Onboarding / data-source flow, run as an honest DEMO: nothing is fetched, read, uploaded, stored or connected.
   It walks through the intended journey (pick a source → coverage check) using the sample ledger,
   and never asks for a real wallet address or account file. */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { CLOSED_TRADES, HISTORY_START, OPEN_POSITIONS, PLATFORM_NAME, SOURCES, type Platform } from '../data/sample'
import { fmtDate } from '../lib/finance'
import { Icon } from './Icon'
import { Modal, useToast } from './overlays'
import { Button, Callout, PlatformBadge, cx } from './ui'

type Step = 'choose' | 'source' | 'checking' | 'coverage'
const Ctx = createContext<(platform?: Platform) => void>(() => {})
export const useConnect = () => useContext(Ctx)

export function ConnectProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ step: Step; platform: Platform } | null>(null)
  return (
    <Ctx.Provider value={(platform) => setState(platform ? { step: 'source', platform } : { step: 'choose', platform: 'pm' })}>
      {children}
      {state && <ConnectModal step={state.step} platform={state.platform} go={(step, platform = state.platform) => setState({ step, platform })} close={() => setState(null)} />}
    </Ctx.Provider>
  )
}

const SAMPLE_WALLET = '0x7a3f…e91c (sample)'
const Demo = () => <span className="demo-tag"><Icon name="flask" size={11} />Demo</span>

export function coverageFor(p: Platform) {
  const open = OPEN_POSITIONS.filter((x) => x.platform === p)
  const closed = CLOSED_TRADES.filter((t) => t.platform === p)
  return {
    open: open.length,
    fills: open.reduce((a, x) => a + x.fills.length, 0) + closed.reduce((a, t) => a + (t.outcome === 'Closed early' ? 2 : 1), 0),
    settlements: closed.filter((t) => t.outcome !== 'Closed early').length,
    feeEstimates: closed.filter((t) => !t.feeKnown).length,
    from: HISTORY_START,
  }
}

function ConnectModal({ step, platform, go, close }: { step: Step; platform: Platform; go: (s: Step, p?: Platform) => void; close: () => void }) {
  const toast = useToast()
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (step !== 'checking') return
    const t = setInterval(() => setProgress((p) => Math.min(p + 25, 100)), 220)
    return () => clearInterval(t)
  }, [step])
  useEffect(() => {
    if (step !== 'checking' || progress < 100) return
    const t = setTimeout(() => go('coverage'), 220)
    return () => clearTimeout(t)
  }, [step, progress, go])
  const start = () => { setProgress(0); go('checking') }
  const finish = () => { close(); toast('Demo finished. Nothing was connected; you’re still on the sample portfolio.', 'info') }

  if (step === 'choose') return (
    <Modal title="Data sources" sub="This prototype only runs on a fictional sample portfolio" onClose={close} width={580}>
      <Callout icon="flask"><b>Demo only.</b> Connecting real accounts isn’t built yet. You can walk through the planned flow with sample data; nothing is read, uploaded or stored.</Callout>
      <button type="button" className="choice" onClick={close}>
        <span className="plat" style={{ background: 'var(--color-accent-solid)' }}>S</span><span>Keep exploring the sample portfolio<small>Every screen works with fictional data. Nothing to set up.</small></span><Icon name="arrowRight" />
      </button>
      <button type="button" className="choice" onClick={() => go('source', 'pm')}>
        <PlatformBadge p="pm" /><span>Preview: Polymarket public wallet <Demo /><small>Planned: paste a public address. In this demo you use the sample wallet.</small></span><Icon name="arrowRight" />
      </button>
      <button type="button" className="choice" onClick={() => go('source', 'ks')}>
        <PlatformBadge p="ks" /><span>Preview: Kalshi CSV import <Demo /><small>Planned: upload your history export. In this demo you use the sample CSV.</small></span><Icon name="arrowRight" />
      </button>
    </Modal>
  )

  if (step === 'source') return (
    <Modal title={platform === 'pm' ? 'Polymarket wallet · demo' : 'Kalshi CSV import · demo'} sub="Step 1 of 2" onClose={close} width={580}
      footer={<><Button variant="ghost" onClick={() => go('choose')}>Back</Button><Button variant="primary" onClick={start}>Run sample coverage check</Button></>}>
      {platform === 'pm' ? (<>
        <div className="field" aria-disabled="true"><label htmlFor="wallet">Wallet address</label><input id="wallet" className="mono" value={SAMPLE_WALLET} readOnly data-autofocus /></div>
        <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Entering your own address is disabled in this prototype, so nothing about a real wallet is looked up.</p>
        <Callout icon="shield">In the planned product, wallet addresses are <b>public</b>: anyone can look up activity for an address. Scevia would only read public data, and you could remove a wallet at any time.</Callout>
      </>) : (<>
        <div className="drop on" aria-disabled="true"><Icon name="download" size={20} /><b>kalshi_history_sample.csv</b><small>Sample file bundled with the prototype. Choosing your own file is disabled.</small></div>
        <Callout>CSV exports can miss fee detail on some settlements. Scevia flags those as estimates instead of guessing.</Callout>
      </>)}
    </Modal>
  )

  if (step === 'checking') return (
    <Modal title="Simulating a coverage check" sub={`${PLATFORM_NAME[platform]} · sample data`} onClose={close} width={580}>
      <div className="bar" style={{ height: 6 }} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Coverage check progress"><i style={{ width: `${progress}%`, background: 'var(--color-accent-solid)', transition: 'width var(--motion-duration-base)' }} /></div>
      <ul className="checks">
        {['Positions', 'Fills', 'Settlements', 'Fees'].map((k, i) => (
          <li key={k} className={cx(progress > i * 25 && 'done')}><Icon name={progress > i * 25 ? 'check' : 'clock'} size={14} />{k}</li>
        ))}
      </ul>
    </Modal>
  )

  const c = coverageFor(platform), src = SOURCES[platform]
  return (
    <Modal title="Coverage check · sample result" sub={`${src.label} · as of ${fmtDate(src.asOf)}`} onClose={close} width={580}
      footer={<><Button variant="ghost" onClick={() => go('choose')}>Try the other source</Button><Button variant="primary" onClick={finish}>Done</Button></>}>
      <div className="row"><Demo /><span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>These numbers describe the sample ledger, not an account of yours.</span></div>
      <div className="cov-grid">
        {[['Open positions', c.open], ['Fills', c.fills], ['Settlements', c.settlements], ['History from', fmtDate(c.from, { month: 'short', year: 'numeric' })]].map(([l, v]) => (
          <div key={l as string}><span className="t3">{l}</span><b>{v}</b></div>
        ))}
      </div>
      {c.feeEstimates
        ? <Callout tone="warn"><b>{c.feeEstimates} settlements</b> have no fee detail. Their fees are shown as estimates and labelled as such.</Callout>
        : <Callout>All fee fields are present, so net P&amp;L for this source is calculated from reported fees.</Callout>}
      {src.stale && <Callout tone="warn">This source is older than 24 hours ({fmtDate(src.asOf)}). Views show a stale-data warning until it’s refreshed.</Callout>}
    </Modal>
  )
}
