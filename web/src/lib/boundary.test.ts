/* Workspace boundary: pages and components never read the bundled fixture directly; they use the selected
   workspace's read model (`useFinance`). Only the fixture service, the development service and tests may. */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['../pages/**/*.{ts,tsx}', '../components/**/*.{ts,tsx}', './*.{ts,tsx}', '!./*.test.ts', '!./fixtureFinance.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('workspace data boundary', () => {
  it('pages, components and shared libraries never import fixture data or fixture-bound calculations', () => {
    const offenders = Object.entries(sources).filter(([, src]) => /^import (?!type )[^\n]*from '[./]*(data\/(portfolio|sample|sampleRecords)|lib\/fixtureFinance|\.\/fixtureFinance)'/m.test(src)).map(([f]) => f).sort()
    // useWorkspace seeds the Sample portfolio's own records only when that workspace is selected; Portfolio offers the
    // labelled sample CSV files in the import flow (files to pick, not portfolio data).
    expect(offenders).toEqual(['../pages/Portfolio.tsx', './useWorkspace.ts'])
    expect(Object.keys(sources).length).toBeGreaterThan(30)
  })
  it('the finance module exposes no portfolio-bound globals', async () => {
    const F = await import('./finance')
    for (const name of ['POSITIONS', 'ACCOUNTS', 'account', 'exposures', 'series', 'TODAY']) expect(name in F).toBe(false)
  })
})
