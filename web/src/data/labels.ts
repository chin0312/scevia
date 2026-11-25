/* Presentation labels for domain values. Kept out of the data model on purpose. */
import type { Category, Platform } from './types'

export const PLATFORM_NAME: Record<Platform, string> = { pm: 'Polymarket', ks: 'Kalshi' }
export const CATEGORIES: Category[] = ['Economics', 'Climate', 'Crypto', 'Politics', 'Sports']
export const CAT_COLOR: Record<Category, string> = {
  Economics: 'var(--color-data-1)', Climate: 'var(--color-data-3)', Crypto: 'var(--color-data-2)', Politics: 'var(--color-data-4)', Sports: 'var(--color-data-5)',
}
