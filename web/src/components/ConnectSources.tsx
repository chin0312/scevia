/* Onboarding / Connect flow (concept doc §6.2): sample mode → paste public wallet or import CSV → coverage check.
   UI only — nothing is fetched, uploaded or stored. */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Modal, useToast } from './overlays'
import { Button, Callout, PlatformBadge, cx } from './ui'

type Step = 'choose' | 'polymarket' | 'kalshi' | 'checking' | 'coverage'
const Ctx = createContext<(start?: Step) => void>(() => {})
export const useConnect = () => useContext(Ctx)

export function ConnectProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<Step | null>(null)
  return (
    <Ctx.Provider value={(s = 'choose') => setStep(s)}>
      {children}
      {step && <ConnectModal step={step} setStep={setStep} />}
    </Ctx.Provider>
  )
}

const WALLET = /^0x[a-fA-F0-9]{40}$/

function ConnectModal({ step, setStep }: { step: Step; setStep: (s: Step | null) => void }) {
  const toast = useToast()
  const [source, setSource] = useState<'pm' | 'ks'>('pm')
  const [wallet, setWallet] = useState('')
  const [touched, setTouched] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const close = () => setStep(null)
  const walletOk = WALLET.test(wallet.trim())

  useEffect(() => {
    if (step !== 'checking') return
    const t = setInterval(() => setProgress((p) => Math.min(p + 20, 100)), 260)
    return () => clearInterval(t)
  }, [step])
  useEffect(() => {
    if (step !== 'checking' || progress < 100) return
    const t = setTimeout(() => setStep('coverage'), 260)
    return () => clearTimeout(t)
  }, [step, progress, setStep])
  const startCheck = () => { setProgress(0); setStep('checking') }

  if (step === 'choose') return (
    <Modal title="Connect a source" sub="Scevia is read-only: it never asks for keys that can trade or move funds." onClose={close} width={560}>
      <button type="button" className="choice" onClick={() => { setSource('pm'); setStep('polymarket') }}>
        <PlatformBadge p="pm" /><span>Polymarket · public wallet address<small>Paste an address. Positions, fills and settlements are read from public data.</small></span><Icon name="arrowRight" />
      </button>
      <button type="button" className="choice" onClick={() => { setSource('ks'); setStep('kalshi') }}>
        <PlatformBadge p="ks" /><span>Kalshi · CSV export<small>Upload your account history CSV. API read-access comes later.</small></span><Icon name="arrowRight" />
      </button>
      <button type="button" className="choice" onClick={() => { close(); toast('You’re exploring the sample portfolio', 'info') }}>
        <span className="plat" style={{ background: 'var(--color-accent-solid)' }}>S</span><span>Keep exploring the sample portfolio<small>Every screen works with fictional data. No account needed.</small></span><Icon name="arrowRight" />
      </button>
    </Modal>
  )

  if (step === 'polymarket') return (
    <Modal title="Polymarket wallet" sub="Step 1 of 2 · public address" onClose={close} width={560}
      footer={<><Button variant="ghost" onClick={() => setStep('choose')}>Back</Button><Button variant="primary" disabled={!walletOk} onClick={startCheck}>Check coverage</Button></>}>
      <div className="field" style={touched && !walletOk ? { borderColor: 'var(--color-loss-fg)' } : undefined}>
        <label htmlFor="wallet">Wallet address</label>
        <input id="wallet" className="mono" placeholder="0x…" autoFocus value={wallet} onChange={(e) => setWallet(e.target.value)} onBlur={() => setTouched(true)} />
      </div>
      {touched && !walletOk && <div className="loss" style={{ fontSize: 'var(--font-size-xs)' }}>That doesn’t look like an address. It should be 0x followed by 40 hex characters.</div>}
      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => { setWallet('0x7a3f9c1d2e4b5a6978c0d1e2f3a4b5c6d7e8e91c'); setTouched(true) }}>Use the sample address</button>
      <Callout icon="shield">Wallet addresses are <b>public</b>. Anyone can look up activity for an address. Scevia stores only what it reads for you, and you can delete it any time.</Callout>
    </Modal>
  )

  if (step === 'kalshi') return (
    <Modal title="Kalshi CSV import" sub="Step 1 of 2 · account history" onClose={close} width={560}
      footer={<><Button variant="ghost" onClick={() => setStep('choose')}>Back</Button><Button variant="primary" disabled={!file} onClick={startCheck}>Check coverage</Button></>}>
      <label className={cx('drop', file && 'on')}>
        <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
        <Icon name="download" size={20} /><b>{file ?? 'Choose a CSV file'}</b><small>{file ? 'Ready to check (prototype: the file isn’t read)' : 'Kalshi → Account → History → Export'}</small>
      </label>
      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setFile('kalshi_history_2026-11-24.csv')}>Use a sample file</button>
      <Callout>CSV exports can miss fee detail on some settlements. Scevia will flag those as estimates rather than guess.</Callout>
    </Modal>
  )

  if (step === 'checking') return (
    <Modal title="Checking data coverage" sub={source === 'pm' ? 'Reading public wallet activity…' : 'Parsing CSV…'} onClose={close} width={560}>
      <div className="bar" style={{ height: 6 }}><i style={{ width: `${progress}%`, background: 'var(--color-accent-solid)', transition: 'width var(--motion-duration-base)' }} /></div>
      <ul className="checks">
        {['Positions', 'Fills', 'Settlements', 'Fees', 'Deposits & withdrawals'].map((k, i) => (
          <li key={k} className={cx(progress > i * 20 && 'done')}><Icon name={progress > i * 20 ? 'check' : 'clock'} size={14} />{k}</li>
        ))}
      </ul>
    </Modal>
  )

  return (
    <Modal title="Coverage check" sub={source === 'pm' ? 'Polymarket · 0x7a…1c' : `Kalshi · ${file}`} onClose={close} width={560}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" onClick={() => { close(); toast(`${source === 'pm' ? 'Polymarket wallet' : 'Kalshi CSV'} connected (prototype)`) }}>Open portfolio</Button></>}>
      <div className="cov-grid">
        {(source === 'pm'
          ? [['Open positions', '6'], ['Fills', '412'], ['Settlements', '41'], ['History from', 'Mar 2025']]
          : [['Open positions', '4'], ['Fills', '188'], ['Settlements', '23'], ['History from', 'Jan 2026']]).map(([l, v]) => (
          <div key={l}><span className="t3">{l}</span><b>{v}</b></div>
        ))}
      </div>
      {source === 'pm'
        ? <Callout>All fields found. Net P&amp;L can be shown as exact for this source.</Callout>
        : <Callout tone="warn"><b>2 settlements</b> have no fee detail. Net P&amp;L will be marked as an estimate (≤ $6 difference) until a newer export fills them in.</Callout>}
      <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Views will say “Connected portfolio: {source === 'pm' ? 'Polymarket' : 'Kalshi'}” until every platform you use is connected.</p>
    </Modal>
  )
}
