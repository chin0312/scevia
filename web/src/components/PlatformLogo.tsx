/* Official platform marks (Polymarket icon, Kalshi “K” from its 2026 wordmark).
   Source files: Wikimedia Commons “Polymarket.svg” (source polymarket.com) and “Kalshi-logo-2026.svg” (source kalshi.com/brandkit).
   Colours come from design tokens (--color-platform-*); paths are drawn with currentColor. */
import type { Platform } from '../data/types'
import { PLATFORM_NAME } from '../data/labels'

const POLY_ICON = 'M136.267 152.495C136.267 159.76 136.267 163.392 133.891 165.192C131.516 166.993 128.019 166.012 121.024 164.049L8.63192 132.51C4.41793 131.328 2.31093 130.737 1.09248 129.129C-0.125977 127.522 -0.125977 125.333 -0.125977 120.957V47.0434C-0.125977 42.6667 -0.125977 40.4783 1.09248 38.8709C2.31093 37.2634 4.41792 36.6722 8.63191 35.4897L121.024 3.95096C128.019 1.98834 131.516 1.00703 133.891 2.80771C136.267 4.60839 136.267 8.24049 136.267 15.5047V152.495ZM27.9043 122.228L120.966 148.345V96.1133L27.9043 122.228ZM15.1738 110.111L108.217 84L15.1738 57.8887V110.111ZM27.9033 45.7725L120.966 71.8877V19.6553L27.9033 45.7725Z'
const KALSHI_K = 'M105.23 105.628L179.66 222.61H115.118L54.3009 121.934V222.61H0V3.38607H54.3009V99.102L119.464 3.38607H177.489L105.23 105.628Z'

/** Compact square badge (22px by default) used next to positions, events and sources. */
export function PlatformBadge({ p, size = 22 }: { p: Platform; size?: number }) {
  return (
    <span className={`plat ${p}`} title={PLATFORM_NAME[p]} role="img" aria-label={PLATFORM_NAME[p]} style={{ width: size, height: size }}>
      {p === 'pm'
        ? <svg viewBox="-18 -12 173 192" width="66%" height="66%" aria-hidden="true"><path d={POLY_ICON} fill="currentColor" /></svg>
        : <svg viewBox="-30 -10 240 245" width="58%" height="58%" aria-hidden="true"><path d={KALSHI_K} fill="currentColor" /></svg>}
    </span>
  )
}
