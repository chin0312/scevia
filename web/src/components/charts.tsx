/* Hand-rolled SVG charts (no chart library): line/area with crosshair tooltip, donut with hover. */
import { useId, useRef, useState, type ReactNode } from 'react'
import { cx } from './ui'

export interface Series { data: number[]; color: string; area?: number; dash?: string; step?: boolean; width?: number }

export function LineChart({ label = 'Line chart', series, w = 820, h = 250, min, max, yTicks, yFmt, xTicks, events, tooltip, hoverSeries = series.length - 1, pad }: {
  label?: string; series: Series[]; w?: number; h?: number; min: number; max: number; yTicks: number[]; yFmt: (v: number) => string
  xTicks: [number, string][]; events?: number[]; tooltip?: (i: number) => ReactNode; hoverSeries?: number; pad?: Partial<{ l: number; r: number; t: number; b: number }>
}) {
  const P = { l: 48, r: 12, t: 12, b: 26, ...pad }
  const n = series[0].data.length
  const x = (i: number) => P.l + (i / (n - 1)) * (w - P.l - P.r)
  const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (h - P.t - P.b)
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const gid = useId().replace(/:/g, '')

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * w
    const i = Math.round(((vx - P.l) / (w - P.l - P.r)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }
  const path = (s: Series) => s.data.map((v, i) => {
    if (!s.step || i === 0) return `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    return `H${x(i).toFixed(1)}V${y(v).toFixed(1)}`
  }).join('')
  const hs = series[hoverSeries]
  const tipLeft = hover != null ? (x(hover) / w) * 100 : 0

  return (
    <div className="chart">
      <svg ref={ref} role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} width="100%" style={{ overflow: 'visible' }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <g className="axis">
          {yTicks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'zero' : 'grid-l'} x1={P.l} x2={w - P.r} y1={y(t)} y2={y(t)} strokeDasharray={t === 0 ? undefined : '2 4'} />
              <text x={P.l - 10} y={y(t) + 4} textAnchor="end">{yFmt(t)}</text>
            </g>
          ))}
          {xTicks.map(([i, t]) => <text key={i} x={x(i)} y={h - 6} textAnchor="middle">{t}</text>)}
        </g>
        {series.map((s, k) => (
          <g key={k}>
            {s.area != null && (
              <>
                <defs><linearGradient id={`${gid}-${k}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" style={{ stopColor: s.color, stopOpacity: s.area }} /><stop offset="1" style={{ stopColor: s.color, stopOpacity: 0 }} />
                </linearGradient></defs>
                <path d={`${path(s)}L${x(n - 1)},${y(min)}L${x(0)},${y(min)}Z`} fill={`url(#${gid}-${k})`} />
              </>
            )}
            <path d={path(s)} fill="none" style={{ stroke: s.color }} strokeWidth={s.width ?? 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {events?.map((e) => <circle key={e} cx={x(e)} cy={h - P.b - 6} r={3} style={{ fill: 'var(--color-bg-surface)', stroke: 'var(--color-accent-fg)' }} strokeWidth={1.5} />)}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={h - P.b} style={{ stroke: 'var(--color-border-strong)' }} strokeDasharray="2 3" />
            <circle cx={x(hover)} cy={y(hs.data[hover])} r={5} style={{ fill: 'var(--color-bg-surface)', stroke: hs.color }} strokeWidth={2.5} />
          </g>
        )}
        <rect className="hit" x={P.l} y={P.t} width={w - P.l - P.r} height={h - P.t - P.b} />
      </svg>
      {hover != null && tooltip && (
        <div className="tip" style={{ left: `${tipLeft}%`, top: 0, transform: `translateX(${tipLeft > 70 ? '-105%' : '8%'})` }}>{tooltip(hover)}</div>
      )}
    </div>
  )
}

export interface Slice { key: string; value: number; color: string }
export function Donut({ parts, size = 132, thickness = 14, center, active, onHover }: {
  parts: Slice[]; size?: number; thickness?: number; center: ReactNode; active?: string | null; onHover?: (k: string | null) => void
}) {
  const r = size / 2 - thickness / 2, c = 2 * Math.PI * r, tot = parts.reduce((a, p) => a + p.value, 0)
  const offs = parts.map((_, i) => parts.slice(0, i).reduce((a, p) => a + (p.value / tot) * c, 0))
  return (
    <div className={cx('donut-wrap', active && 'dim')} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        {parts.map((p, i) => {
          const len = (p.value / tot) * c, off = offs[i]
          return (
            <circle key={p.key} className={cx('hoverable', active === p.key && 'hot')} cx={size / 2} cy={size / 2} r={r} fill="none"
              style={{ stroke: p.color }} strokeWidth={active === p.key ? thickness + 4 : thickness}
              strokeDasharray={`${Math.max(len - 3, 0)} ${c}`} strokeDashoffset={-off}
              onMouseEnter={() => onHover?.(p.key)} onMouseLeave={() => onHover?.(null)} />
          )
        })}
      </svg>
      <div className="c">{center}</div>
    </div>
  )
}
