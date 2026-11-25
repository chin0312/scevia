/* Data sources panel: what the figures are based on, and the ways a user can provide their own data.
   The user chooses their sources; none is required, and a file import is a source in its own right (any provider).
   Connections and imports don't work in this build, so their actions are disabled rather than simulated. */
import { createContext, useContext, useState, type ReactNode } from 'react'
import { PLATFORM_NAME } from '../data/labels'
import { PORTFOLIO } from '../data/portfolio'
import type { Platform } from '../data/types'
import { coverage, fmtDate, sourceOf } from '../lib/finance'
import { Icon } from './Icon'
import { Modal } from './overlays'
import { Button, Callout, Chip, PlatformBadge, cx } from './ui'

const Ctx = createContext<() => void>(() => {})
export const useConnect = () => useContext(Ctx)

const METHOD: Record<Platform, string> = {
  pm: 'Track a public wallet address, read-only. An address identifies a wallet; it isn’t proof that you own it.',
  ks: 'Read-only account access, with your explicit consent.',
}

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
    <Modal title="Data sources" sub="You choose which sources Scevia reads. It never places trades, moves funds, or asks for private keys or seed phrases." onClose={onClose} width={600}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {PORTFOLIO.isSample && (
        <div className="source-row active">
          <span className="plat" style={{ background: 'var(--color-accent-solid)' }}>S</span>
          <div><b>Sample portfolio</b><small>A fictional Polymarket + Kalshi portfolio. Every figure in Scevia currently comes from it.</small></div>
          <Chip tone="accent">Active</Chip>
        </div>
      )}
      <h5 className="caps">Your sources</h5>
      {(['pm', 'ks'] as Platform[]).map((p) => (
        <div className="source-row" key={p}>
          <PlatformBadge p={p} />
          <div><b>{PLATFORM_NAME[p]}</b><small>{METHOD[p]}</small></div>
          <span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Not connected</span>
          <Button size="sm" disabled title="Not available in this version">Connect</Button>
        </div>
      ))}
      <div className="source-row">
        <span className="plat file" aria-hidden="true"><Icon name="download" size={13} /></span>
        <div><b>File import (CSV)</b><small>Your own transaction records, from any prediction market. Use it on its own or alongside a connection.</small></div>
        <span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>No files</span>
        <Button size="sm" disabled title="Not available in this version">Import</Button>
      </div>
      <Callout icon="info">Connecting accounts and importing files aren’t available in this version. You can explore every module with the sample portfolio.</Callout>
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
