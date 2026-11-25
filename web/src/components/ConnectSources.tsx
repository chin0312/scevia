/* Data sources panel: what the figures are based on, and which accounts are connected.
   Account connections aren't available yet, so their actions are disabled rather than simulated. */
import { createContext, useContext, useState, type ReactNode } from 'react'
import { PLATFORM_NAME } from '../data/labels'
import { PORTFOLIO } from '../data/portfolio'
import type { Platform } from '../data/types'
import { coverage, fmtDate, sourceOf } from '../lib/finance'
import { Icon } from './Icon'
import { Modal } from './overlays'
import { PlatformWordmark } from './PlatformLogo'
import { Button, Callout, Chip, PlatformBadge, cx } from './ui'

const Ctx = createContext<() => void>(() => {})
export const useConnect = () => useContext(Ctx)

const METHOD: Record<Platform, string> = { pm: 'Public wallet address (read-only)', ks: 'Account history import (read-only)' }

export function ConnectProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Ctx.Provider value={() => setOpen(true)}>
      {children}
      {open && <DataSources onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  )
}

function DataSources({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Data sources" sub="Scevia only reads portfolio data. It never places trades or moves funds." onClose={onClose} width={600}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {PORTFOLIO.isSample && (
        <div className="source-row active">
          <span className="plat" style={{ background: 'var(--color-accent-solid)' }}>S</span>
          <div><b>Sample portfolio</b><small>A fictional Polymarket + Kalshi portfolio. Every figure in Scevia currently comes from it.</small></div>
          <Chip tone="accent">Active</Chip>
        </div>
      )}
      <h5 className="caps">Your accounts</h5>
      {(['pm', 'ks'] as Platform[]).map((p) => (
        <div className="source-row" key={p}>
          <PlatformBadge p={p} />
          <div><b className="sr-only">{PLATFORM_NAME[p]}</b><PlatformWordmark p={p} height={p === 'pm' ? 16 : 18} /><small>{METHOD[p]}</small></div>
          <span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Not connected</span>
          <Button size="sm" disabled title="Connecting your own accounts isn’t available yet">Connect</Button>
        </div>
      ))}
      <Callout icon="info">Connecting your own Polymarket and Kalshi accounts isn’t available yet. Until then you can explore every module with the sample portfolio.</Callout>
      {PORTFOLIO.isSample && <SampleCoverage />}
    </Modal>
  )
}

function SampleCoverage() {
  return (
    <>
      <h5 className="caps">Sample data coverage</h5>
      {(['pm', 'ks'] as Platform[]).map((p) => {
        const c = coverage(p), src = sourceOf(p)
        return (
          <div className="cov" key={p}><PlatformBadge p={p} /><span>{c.open} open · {c.fills} fills · {c.settlements} settlements{c.feeEstimates ? ` · ${c.feeEstimates} fee estimates` : ''}</span>
            <span className={cx(src.stale ? 'stale' : 't3')}>{src.stale && <Icon name="alert" size={12} />} as of {fmtDate(src.asOf)}</span></div>
        )
      })}
    </>
  )
}
