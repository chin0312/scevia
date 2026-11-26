/* Small presentational primitives. Each maps 1:1 to an entry in design-system/components.md. */
import type { ReactNode } from 'react'
import type { Side } from '../data/types'
import { splitMoney, reportingCode } from '../lib/format'
import { Icon, type IconName } from './Icon'
import { InfoTip } from './overlays'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/* Card */
export function Card({ id, className, children, flush }: { id?: string; className?: string; children: ReactNode; flush?: boolean }) {
  return <section id={id} className={cx('card anchor', className)} style={flush ? { overflow: 'hidden' } : undefined}>{children}</section>
}
export function CardHeader({ title, sub, info, right, pad }: { title: ReactNode; sub?: ReactNode; info?: string; right?: ReactNode; pad?: boolean }) {
  return (
    <div className="card-h" style={pad ? { paddingBottom: 'var(--space-4)' } : undefined}>
      <div><h3>{title}{info && <> <InfoTip text={info} /></>}</h3>{sub && <p>{sub}</p>}</div>
      {right}
    </div>
  )
}

/* Segmented control (2–5 mutually exclusive views) */
export function Seg<T extends string>({ options, value, onChange, label, disabled }: { options: readonly T[]; value: T; onChange: (v: T) => void; label: string; disabled?: (o: T) => string | null }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={o === value} className={cx(o === value && 'on')} disabled={!!disabled?.(o)} title={disabled?.(o) ?? undefined} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  )
}

/* Tabs inside a card (buttons, arrow keys move between tabs) */
export function Tabs<T extends string>({ options, value, onChange, render, label = 'Views' }: { options: readonly T[]; value: T; onChange: (v: T) => void; render?: (o: T) => ReactNode; label?: string }) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const n = options[(i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]
    onChange(n)
    ;((e.currentTarget.parentElement?.children[options.indexOf(n)]) as HTMLElement | undefined)?.focus()
  }
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o, i) => (
        <button type="button" key={o} role="tab" aria-selected={o === value} tabIndex={o === value ? 0 : -1} className={cx(o === value && 'on')}
          onClick={() => onChange(o)} onKeyDown={(e) => onKey(e, i)}>{render ? render(o) : o}</button>
      ))}
    </div>
  )
}

/* Filter pills (multi or single) */
export function Pills<T extends string>({ options, value, onChange, counts, label = 'Filter' }: { options: readonly T[]; value: T; onChange: (v: T) => void; counts?: Partial<Record<T, number>>; label?: string }) {
  return (
    <div className="pills" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={o === value} className={cx('pill', o === value && 'on')} onClick={() => onChange(o)}>
          {o}{counts?.[o] != null && <span className="n">{counts[o]}</span>}
        </button>
      ))}
    </div>
  )
}

export function Chip({ tone, children }: { tone?: 'yes' | 'no' | 'warn' | 'info' | 'accent'; children: ReactNode }) {
  return <span className={cx('chip', tone)}>{children}</span>
}
export const SideChip = ({ side }: { side: Side }) => <Chip tone={side === 'YES' ? 'yes' : 'no'}>{side}</Chip>
export { PlatformBadge } from './PlatformLogo'

export function Delta({ value, children, tone }: { value?: number; children: ReactNode; tone?: 'gain' | 'loss' | 'flat' }) {
  const t = tone ?? (value == null || Math.abs(value) < 0.5 ? 'flat' : value > 0 ? 'gain' : 'loss')
  return <span className={cx('delta', t)}>{children}</span>
}

export function HeroFigure({ value, currency }: { value: number; currency?: string }) {
  const m = splitMoney(value)
  return <div className="hero-fig">{m.sign}{m.symbol}{m.int}<span className="dec">.{m.dec}</span><span className="cur">{currency ?? reportingCode()}</span></div>
}

export function Tile({ label, info, value, foot, tone }: { label: string; info?: string; value: ReactNode; foot?: ReactNode; tone?: 'gain' | 'loss' | 'warn' }) {
  return (
    <div className="tile">
      <div className="l">{label}{info && <InfoTip text={info} />}</div>
      <div className={cx('v', tone === 'gain' && 'gain', tone === 'loss' && 'loss')} style={tone === 'warn' ? { color: 'var(--color-warn-fg)' } : undefined}>{value}</div>
      {foot && <div className="f">{foot}</div>}
    </div>
  )
}

export function Callout({ tone = 'info', icon, children }: { tone?: 'info' | 'warn'; icon?: IconName; children: ReactNode }) {
  return <div className={cx('callout', tone)}><Icon name={icon ?? (tone === 'warn' ? 'alert' : 'info')} size={15} /><span>{children}</span></div>
}

export function Button({ variant, size, icon, children, onClick, disabled, title, type = 'button', 'aria-label': ariaLabel }: {
  variant?: 'primary' | 'ghost' | 'accent'; size?: 'sm'; icon?: IconName; children?: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; type?: 'button' | 'submit'; 'aria-label'?: string
}) {
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} aria-label={ariaLabel}
      className={cx('btn', variant && `btn-${variant}`, size === 'sm' && 'btn-sm')}>
      {icon && <Icon name={icon} size={15} />}{children}
    </button>
  )
}

export function Legend({ items }: { items: { label: string; color?: string; kind?: 'sq' | 'ln' | 'dash' }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}><i className={it.kind === 'ln' ? 'ln' : it.kind === 'dash' ? 'dash' : undefined} style={it.color ? { background: it.color } : undefined} />{it.label}</span>
      ))}
    </div>
  )
}

export function PageHead({ caption, title, actions }: { caption: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <section className="page-head anchor" id="summary">
      <div><div className="caps">{caption}</div><h1>{title}</h1></div>
      {actions && <div className="actions">{actions}</div>}
    </section>
  )
}

export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="empty"><Icon name="search" size={18} /><p>{text}</p>{action}</div>
}
