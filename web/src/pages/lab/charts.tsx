/* Scenario Lab charts. Small SVG primitives that each answer one question; every chart has a text equivalent
   (aria-label) and direct labels, and unavailable values are drawn as "unavailable", never as zero. */
import type { ReactNode } from 'react'
import { useWidth } from '../../components/charts'
import { cx } from '../../components/ui'
import { kfmt, sfmt } from '../../lib/format'

const niceStep = (span: number) => { const p = 10 ** Math.floor(Math.log10(Math.max(1, span) / 4)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => span / s <= 5) ?? p * 10 }
function ticks(lo: number, hi: number) {
  const st = niceStep(hi - lo), out: number[] = []
  for (let t = Math.ceil(lo / st) * st; t <= hi + 1e-9; t += st) out.push(t)
  return out
}
/** Axis labels precise enough for the visible span (a $200 span on a $40k total needs more than "$40k"). */
const wfmt = (v: number, span: number) => (span < 2000 && Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}` : money(v))
const money = (v: number) => (Math.abs(v) < 0.5 ? '$0' : `${v < 0 ? '−' : ''}${kfmt(Math.abs(v))}`)

/* ── Range rows: worst → best feasible settlement value per row, with the reference value marked ── */
export interface RangeRow { key: string; label: ReactNode; text: string; lo: number | null; hi: number | null; ref?: number | null; color: string; muted?: boolean }
export function RangeRows({ rows, label, refLabel = 'value at mark' }: { rows: RangeRow[]; label: string; refLabel?: string }) {
  const [wrap, W] = useWidth<HTMLDivElement>(560)
  const vals = rows.flatMap((r) => [r.lo, r.hi, r.ref]).filter((v): v is number => v != null && Number.isFinite(v))
  if (!vals.length) return <div className="empty"><p>Settlement range is unavailable.</p></div>
  const compact = W < 520, left = compact ? 0 : 168, rowH = compact ? 56 : 44, top = 8
  let lo = Math.min(0, ...vals), hi = Math.max(...vals)
  const pad = (hi - lo) * 0.06 || 1; lo -= lo < 0 ? pad : 0; hi += pad
  const X = (v: number) => left + 8 + ((v - lo) / (hi - lo)) * (W - left - (compact ? 24 : 64))
  const H = rows.length * rowH + top + 26
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${label}. ${rows.map((r) => r.text).join('. ')}`}>
        <g className="axis">{ticks(lo, hi).map((t) => <g key={t}><line className={t ? 'grid-l' : 'zero'} x1={X(t)} x2={X(t)} y1={top} y2={H - 22} strokeDasharray={t ? '2 4' : undefined} /><text x={X(t)} y={H - 6} textAnchor="middle">{money(t)}</text></g>)}</g>
        {rows.map((r, i) => {
          const y = top + i * rowH + (compact ? 32 : rowH / 2)
          return (
            <g key={r.key} opacity={r.muted ? 0.55 : 1}>
              <text className="name" x={compact ? 0 : 0} y={compact ? y - 16 : y + 4}>{r.label}</text>
              {r.lo == null || r.hi == null ? <text className="ax" x={X(lo) + 4} y={y + 4}>Unavailable</text> : (<>
                <line x1={X(r.lo)} x2={X(r.hi)} y1={y} y2={y} style={{ stroke: r.color }} strokeWidth={8} strokeLinecap="round" opacity={0.35} />
                <circle cx={X(r.lo)} cy={y} r={5} style={{ fill: 'var(--color-bg-surface)', stroke: r.color }} strokeWidth={2} />
                <circle cx={X(r.hi)} cy={y} r={5} style={{ fill: r.color }} />
                {r.ref != null && <line x1={X(r.ref)} x2={X(r.ref)} y1={y - 9} y2={y + 9} style={{ stroke: 'var(--color-text-primary)' }} strokeWidth={2}><title>{refLabel}</title></line>}
                {!compact && Math.abs(r.hi - r.lo) >= 0.5 && <text className="lbl" x={X(r.lo) - 9} y={y + 4} textAnchor="end">{money(r.lo)}</text>}
                {compact ? <text className="lbl" x={W - 2} y={y - 16} textAnchor="end">{`${money(r.lo)} – ${money(r.hi)}`}</text> : <text className="lbl" x={X(r.hi) + 9} y={y + 4}>{money(r.hi)}</text>}
              </>)}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ── Waterfall: a starting total, signed steps, an ending total ── */
export interface Step { label: string; value: number; kind: 'total' | 'step'; note?: string; muted?: boolean }
export function Waterfall({ steps, label }: { steps: Step[]; label: string }) {
  const [wrap, W] = useWidth<HTMLDivElement>(560)
  const bars = steps.reduce<(Step & { from: number; to: number })[]>((acc, s) => {
    const run = acc.length ? acc[acc.length - 1].to : 0
    return [...acc, { ...s, from: s.kind === 'total' ? 0 : run, to: s.kind === 'total' ? s.value : run + s.value }]
  }, [])
  // Totals dwarf the steps, so the axis starts near the smallest value (said in the chart) to keep the steps visible.
  const all = bars.flatMap((b) => (b.kind === 'total' ? [b.to] : [b.from, b.to]))
  let lo = Math.min(...all), hi = Math.max(...all)
  const span = hi - lo, base = Math.max(0, lo - Math.max(span * 0.8, Math.abs(hi) * 0.02, 1))
  const cut = base > 0
  lo = base; hi = hi + Math.max(span * 0.15, Math.abs(hi) * 0.005, 1)
  const H = 210, top = 24, bottom = 44, n = bars.length, slot = (W - 64) / n, bw = Math.min(64, slot * 0.6)
  const Y = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (H - top - bottom)
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${label}. ${steps.map((s) => `${s.label} ${s.kind === 'total' ? money(s.value) : sfmt(s.value, 2)}`).join(', ')}`}>
        <g className="axis">{ticks(lo, hi).map((t) => <g key={t}><line className="grid-l" x1={60} x2={W} y1={Y(t)} y2={Y(t)} strokeDasharray="2 4" /><text x={56} y={Y(t) + 4} textAnchor="end">{wfmt(t, hi - lo)}</text></g>)}
          {cut && <text x={64} y={top - 10} className="ax">Axis starts at {wfmt(lo, hi - lo)}</text>}</g>
        {bars.map((b, i) => {
          const from = b.kind === 'total' ? lo : b.from
          const x = 64 + i * slot + (slot - bw) / 2, y1 = Y(Math.max(from, b.to)), y2 = Y(Math.min(from, b.to))
          const fill = b.kind === 'total' ? 'var(--color-text-tertiary)' : b.value >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)'
          return (
            <g key={b.label} opacity={b.muted ? 0.5 : 1}>
              {i > 0 && <line x1={x - (slot - bw)} x2={x} y1={Y(b.from)} y2={Y(b.from)} style={{ stroke: 'var(--color-border-strong)' }} strokeDasharray="2 2" />}
              <rect x={x} y={y1} width={bw} height={Math.max(1.5, y2 - y1)} rx={2} style={{ fill }} opacity={b.kind === 'total' ? 0.55 : 0.9} />
              <text className="lbl" x={x + bw / 2} y={y1 - 6} textAnchor="middle">{b.kind === 'total' ? wfmt(b.value, hi - lo) : Math.abs(b.value) < 0.005 ? '$0' : sfmt(b.value, Math.abs(b.value) < 100 ? 2 : 0)}</text>
              <text className="ax" x={x + bw / 2} y={H - bottom + 16} textAnchor="middle">{b.label}</text>
              {b.note && <text className="ax" x={x + bw / 2} y={H - bottom + 30} textAnchor="middle">{b.note}</text>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ── 100% stacked bars (one per row) with interactive segments ── */
export interface StackSeg { key: string; label: string; value: number; color: string }
export function StackBars({ rows, selected, onSelect, label }: { rows: { key: string; label: ReactNode; segs: StackSeg[] | null; total: number | null; note?: ReactNode }[]; selected?: string | null; onSelect?: (k: string | null) => void; label: string }) {
  return (
    <div className="stack-bars" role="group" aria-label={label}>
      {rows.map((r) => (
        <div className="sb-row" key={r.key}>
          <div className="sb-l">{r.label}{r.note && <small className="t3">{r.note}</small>}</div>
          {r.segs == null || !r.total ? <div className="sb-bar sb-na">{r.segs == null ? 'Unavailable' : 'Nothing held'}</div> : (
            <div className={cx('sb-bar', selected && 'dim')}>
              {r.segs.filter((s) => s.value > 0).map((s) => {
                const share = s.value / r.total!
                return (
                  <button type="button" key={s.key} className={cx('sb-seg', 'hoverable', selected === s.key && 'hot')} style={{ width: `${share * 100}%`, background: s.color }}
                    aria-pressed={selected === s.key} aria-label={`${s.label}: ${(share * 100).toFixed(1)}%`} title={`${s.label} · ${(share * 100).toFixed(1)}%`}
                    onClick={() => onSelect?.(selected === s.key ? null : s.key)}>{share >= 0.09 ? <span>{(share * 100).toFixed(0)}%</span> : null}</button>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/* ── Paired horizontal bars: before (outline) and after (solid) per row, signed around zero ── */
export interface PairRow { key: string; label: string; before: number | null; after: number | null; tag?: ReactNode; onClick?: () => void }
export function PairBars({ rows, label, fmtV = (v: number) => sfmt(v) }: { rows: PairRow[]; label: string; fmtV?: (v: number) => string }) {
  const vals = rows.flatMap((r) => [r.before, r.after]).filter((v): v is number => v != null)
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1
  const pos = (v: number) => ((v - lo) / span) * 100
  return (
    <div className="pair-bars" role="list" aria-label={label}>
      {rows.map((r) => (
        <div role="listitem" key={r.key} className="pb-row">
          <div className="pb-l">{r.onClick ? <button type="button" className="link pb-link" onClick={r.onClick}>{r.label}</button> : <span>{r.label}</span>}{r.tag}</div>
          <div className="pb-track" aria-hidden="true">
            <span className="pb-zero" style={{ left: `${pos(0)}%` }} />
            {r.before != null && <i className="pb-b" style={{ left: `${pos(Math.min(0, r.before))}%`, width: `${Math.abs(r.before) / span * 100}%` }} />}
            {r.after != null && <i className={cx('pb-a', r.after < 0 ? 'neg' : 'pos')} style={{ left: `${pos(Math.min(0, r.after))}%`, width: `${Math.max(0.4, Math.abs(r.after) / span * 100)}%` }} />}
          </div>
          <div className="pb-v r"><span className="t3">{r.before == null ? '—' : fmtV(r.before)}</span> → <b className={cx(r.after != null && (r.after < 0 ? 'loss' : r.after > 0 ? 'gain' : ''))}>{r.after == null ? 'n/a' : fmtV(r.after)}</b></div>
        </div>
      ))}
    </div>
  )
}
