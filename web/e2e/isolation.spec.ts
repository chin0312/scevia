/* Workspace isolation with the development-only service (two distinct fixture portfolios, a slow one, a failing one,
   and one whose refresh fails). Switching must change the figures, records, search and scenarios, never only the title. */
import { expect, test, type Page } from '@playwright/test'
import { FIXTURE_B } from '../src/data/devWorkspaces'
import { createFinance } from '../src/lib/finance'
import { account as sampleAccount } from '../src/lib/fixtureFinance'
import { fmt } from '../src/lib/format'

const B = createFinance(FIXTURE_B)
const hero = (v: number) => fmt(Math.trunc(v)).replace('$', '')
const start = async (page: Page, path: string) => {
  await page.goto(path)
  await page.evaluate(() => { sessionStorage.clear(); sessionStorage.setItem('scevia-dev-workspaces', '1') })
  await page.goto(path)
}
const choose = async (page: Page, name: RegExp) => {
  await page.getByRole('button', { name: /^Portfolio:/ }).click()
  await page.getByRole('menuitemradio', { name }).click()
}

test('isolation: two workspaces show their own holdings, value, accounts, records, search and scenarios', async ({ page }) => {
  await start(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Modify current portfolio' }).click()
  await page.keyboard.press('Enter')
  await page.goto('/overview')
  await expect(page.locator('.hero-card')).toContainText(hero(sampleAccount('all').totalValue))
  await expect(page.locator('#holdings tbody tr')).toHaveCount(10)

  await choose(page, /Development fixture B/)
  await expect(page.getByLabel('Loading Development fixture B')).toBeVisible()
  await expect(page.locator('.hero-card')).toContainText(hero(B.account('all').totalValue))
  await expect(page.locator('.hero-card')).not.toContainText(hero(sampleAccount('all').totalValue))
  await expect(page.locator('#holdings tbody tr')).toHaveCount(3)
  await expect(page.locator('#coverage')).toContainText('pUSD')

  const menu = async () => { await page.getByRole('button', { name: /^Portfolio:/ }).click(); return page.getByRole('menu', { name: 'Portfolio' }) }
  const m = await menu()
  await expect(m).toContainText('Fixture B wallet')
  await expect(m).not.toContainText('Main account')
  await page.keyboard.press('Escape')

  await page.goto('/portfolio/transactions')
  await expect(page.locator('main')).toContainText('Fixture B wallet')
  await expect(page.locator('main')).not.toContainText('Wallet 0x7a')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Search Scevia' }).fill('untitled')
  // Scenarios are the user's collection (searchable anywhere); this one keeps its frozen Sample start.
  await expect(page.getByRole('listbox', { name: 'Results' })).toContainText('From Sample portfolio')
  await page.keyboard.press('Escape')
  await page.goto('/scenario-lab')
  await expect(page.getByText(/Starts from Sample portfolio as of Nov 24\. That portfolio isn’t selected now/)).toBeVisible()

  await choose(page, /^Sample portfolio/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Untitled scenario')
  await page.goto('/overview')
  await expect(page.locator('#holdings tbody tr')).toHaveCount(10)
})

test('isolation: a late response from a previous selection never replaces the current workspace', async ({ page }) => {
  await start(page, '/overview')
  await choose(page, /Development fixture B/) // takes 1.2 s
  await choose(page, /^Sample portfolio/)
  await expect(page.locator('#holdings tbody tr')).toHaveCount(10)
  await page.waitForTimeout(1600)
  await expect(page.getByRole('button', { name: /^Portfolio:/ })).toHaveAccessibleName('Portfolio: Sample portfolio')
  await expect(page.locator('#holdings tbody tr')).toHaveCount(10)
  await expect(page.locator('.hero-card')).toContainText(hero(sampleAccount('all').totalValue))
})

test('isolation: a failed workspace shows its error, never another portfolio’s records', async ({ page }) => {
  await start(page, '/portfolio/transactions')
  await expect(page.locator('main')).toContainText('Wallet 0x7a')
  await choose(page, /Development fixture C/)
  await expect(page.getByRole('heading', { name: 'Development fixture C couldn’t be loaded' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Wallet 0x7a')
  await page.goto('/risk')
  await expect(page.getByRole('heading', { name: 'Development fixture C couldn’t be loaded' })).toBeVisible()
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(page.getByRole('menu', { name: 'Notifications' })).toContainText('No notifications for this portfolio.')
})

test('freshness: a failed refresh keeps the last data and says it isn’t newly synchronized', async ({ page }) => {
  await start(page, '/analytics')
  await choose(page, /Development fixture D/)
  await page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: '3M' }).click()
  await page.getByRole('button', { name: /^Data status/ }).click()
  await page.getByRole('menu', { name: 'Data status' }).getByRole('menuitem', { name: 'Refresh now' }).click()
  await expect(page.getByText('Couldn’t refresh. Showing the last data, not newly checked.')).toBeVisible()
  await expect(page.getByRole('menu', { name: 'Data status' })).toContainText('it isn’t newly synchronized')
  await expect(page.getByRole('menu', { name: 'Data status' }).getByRole('menuitem', { name: 'Try again' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Data status: Refresh failed' })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: '3M' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('discovery: markets beyond the local catalog, links and ids, partial evidence and failures, through the injected service', async ({ page }) => {
  await start(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Build from scratch' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add markets' })
  await dlg.getByRole('tab', { name: 'Search markets' }).click()
  await dlg.getByLabel('Search markets').fill('slow fed')
  await dlg.getByLabel('Search markets').fill('ECB')
  // A multi-market event: both markets listed, nothing selected for the user; the unpriced one is found, not priced.
  await expect(dlg.getByText('ECB cuts rates in Jan 2027')).toBeVisible()
  await expect(dlg.getByText('ECB holds rates in Jan 2027')).toBeVisible()
  // Scoped to the market's own row: only that market is found but not priced.
  const hold = dlg.locator('.addpos-market', { hasText: 'ECB holds rates in Jan 2027' })
  await expect(hold).toContainText('No price yet')
  await expect(hold.getByRole('button', { name: 'Select ECB holds rates in Jan 2027 YES' })).toContainText('no price')
  await expect(dlg.locator('.addpos-market', { hasText: 'ECB cuts rates in Jan 2027' })).not.toContainText('No price yet')
  // Only results for the current query are shown: nothing from the earlier (empty or "slow fed") queries.
  await expect(dlg.locator('.addpos-market')).toHaveCount(2)
  await expect(dlg.getByRole('button', { name: /^Deselect/ })).toHaveCount(0)
  await page.waitForTimeout(1700) // the slow earlier request must not replace the latest results
  await expect(dlg.getByText('ECB cuts rates in Jan 2027')).toBeVisible()
  await expect(dlg.getByText('Fed rate cut in December?')).toHaveCount(0)
  await dlg.getByRole('button', { name: 'Select ECB cuts rates in Jan 2027 NO at reference 0.63' }).click()
  await expect(dlg.getByRole('button', { name: /Add 1 position/ })).toBeEnabled()
  await dlg.getByLabel('Search markets').fill('outage')
  await expect(dlg.getByText('Market search isn’t available right now.')).toBeVisible()
  await dlg.getByRole('tab', { name: 'Paste link' }).click()
  await dlg.getByLabel('Market link').fill('https://kalshi.com/markets/kxscalar-27')
  await dlg.getByRole('button', { name: 'Find market' }).click()
  await expect(dlg.getByText(/market type isn’t supported/)).toBeVisible()
  await dlg.getByLabel('Market link').fill('KXECB-27JAN-HOLD')
  await dlg.getByRole('button', { name: 'Find market' }).click()
  await expect(dlg.getByText('ECB holds rates in Jan 2027')).toBeVisible()
  await dlg.getByLabel('Market link').fill('https://kalshi.com/markets/kxdown')
  await dlg.getByRole('button', { name: 'Find market' }).click()
  await expect(dlg.getByText('Market data is temporarily unavailable for this link.')).toBeVisible()
})

test('independent simulation: a scratch scenario and a replay stay in the collection across portfolios', async ({ page }) => {
  await start(page, '/scenario-lab')
  await page.getByRole('button', { name: /^Portfolio:/ }).click()
  await page.getByRole('menuitemradio', { name: /Development fixture C/ }).click()
  await page.getByLabel('Starting capital on Kalshi').fill('500')
  await page.getByRole('button', { name: 'Build from scratch' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('From scratch')
  // The starting-portfolio choice can't select a current portfolio that has no data.
  await expect(page.getByRole('radiogroup', { name: 'Starting portfolio' }).getByRole('radio', { name: 'Current portfolio' })).toBeDisabled()
  await page.goto('/scenario-lab/replay?new=1')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Historical replay 1')
  await page.getByRole('button', { name: /^Portfolio:/ }).click()
  await page.getByRole('menuitemradio', { name: /Development fixture B/ }).click()
  await page.goto('/scenario-lab')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('From scratch')
  await page.getByRole('option', { name: /All scenarios/ }).click()
  await expect(page.getByRole('button', { name: 'Open Historical replay 1', exact: true })).toBeVisible()
})

test('reporting currency: a global setting that converts portfolio money but not native units', async ({ page }) => {
  await start(page, '/overview')
  await page.getByRole('button', { name: 'Settings' }).click()
  const options = page.getByLabel('Reporting currency').locator('option')
  await expect(options).toHaveText(['US Dollar (USD)', 'Euro (EUR)', 'British Pound (GBP)'])
  await page.getByLabel('Reporting currency').selectOption('EUR')
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  await expect(dlg).toContainText('Exchange rates are selected automatically.')
  await dlg.getByText('Rates in use').click()
  await expect(dlg.getByLabel('Exchange rates in use')).toContainText('USD to EUR0.9200, ECB')
  await expect(dlg).toContainText('Sample rates. They are fixed, not live.')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.hero-fig')).toContainText('€')
  // Native amounts keep their own units; only the portfolio total is converted.
  await expect(page.locator('#coverage')).toContainText('24,768.00 USDC')
  // No exchange-rate equation on the dashboard; the rates stay in Settings and Data coverage.
  await expect(page.locator('main')).not.toContainText('1 USDC =')
  await page.goto('/portfolio/coverage')
  await expect(page.getByLabel('Exchange rates in use')).toContainText('USD to EUR0.9200')
  await page.goto('/overview')
  await expect(page.locator('.hero-fig')).toContainText('€')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Reporting currency').selectOption('GBP')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.hero-fig')).toContainText('£')
  await page.getByRole('button', { name: /^Data status/ }).click()
  await expect(page.getByRole('menu', { name: 'Data status' })).toContainText('Exchange rates')
})

test('replay picker: exact outcomes, picks kept across queries, link mode states, funding by settlement asset', async ({ page }) => {
  await start(page, '/scenario-lab/replay?new=1')
  await page.getByRole('button', { name: 'Add markets…' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add markets' })
  await dlg.getByLabel('Search markets').fill('Brent')
  const brent = dlg.getByRole('group', { name: 'Brent above $90 on Mar 31' })
  await expect(brent).toContainText('Settles in pUSD')
  await brent.getByRole('button', { name: 'Select Brent above $90 on Mar 31 NO' }).click()
  await dlg.getByLabel('Search markets').fill('Bitcoin')
  await dlg.getByRole('group', { name: 'Bitcoin above $150k on Dec 31' }).getByRole('button', { name: /YES$/ }).click()
  // Picks survive the query change; the count matches the basket.
  await expect(dlg.getByLabel('Selected positions')).toContainText('Brent above $90 on Mar 31 NO (pUSD)')
  await expect(dlg.getByLabel('Selected positions')).toContainText('Bitcoin above $150k on Dec 31 YES (USDC)')
  await expect(dlg.getByRole('button', { name: 'Add 2 positions' })).toBeEnabled()
  // A market whose settlement asset isn't established can't be selected.
  await dlg.getByLabel('Search markets').fill('Copper')
  await expect(dlg.getByRole('group', { name: 'Copper above $5 on Dec 31' })).toContainText('Settlement currency unknown')
  await expect(dlg.getByRole('group', { name: 'Copper above $5 on Dec 31' }).getByRole('button')).toHaveCount(0)
  // Link or id is an explicit mode with its own states.
  await dlg.getByRole('radiogroup', { name: 'Find by' }).getByRole('radio', { name: 'Link or id' }).click()
  await dlg.getByLabel('Market link or id').fill('https://kalshi.com/markets/kxscalar-27')
  await expect(dlg.getByText(/market type isn’t supported/)).toBeVisible()
  await dlg.getByLabel('Market link or id').fill('https://example.com/x')
  await expect(dlg.getByText('Links from example.com aren’t supported.', { exact: false })).toBeVisible()
  await dlg.getByRole('button', { name: 'Add 2 positions' }).click()
  // Funding matched by venue and asset: separate USDC and PUSD virtual buckets.
  await expect(page.getByLabel('Starting capital, Polymarket USDC')).toBeVisible()
  await expect(page.getByLabel('Starting capital, Polymarket pUSD')).toBeVisible()
  await expect(page.getByRole('group', { name: /Brent above/ })).toContainText('Virtual funds (pUSD)')
})

test('legacy migration: an old current-portfolio scenario keeps its configuration but no invented baseline', async ({ page }) => {
  await page.goto('/scenario-lab')
  await page.evaluate(() => {
    sessionStorage.clear()
    sessionStorage.setItem('scevia-scenarios-v4', JSON.stringify([{ key: 'old', name: 'Old scenario', baseline: 'portfolio', funding: { pm: 100 }, assumptions: {}, adjs: [{ id: 'btc', to: 1000, price: 0.3 }], saved: null, savedAt: null, color: '' }]))
    sessionStorage.setItem('scevia-active-v4', JSON.stringify('old'))
  })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Old scenario')
  await expect(page.getByText('Original starting portfolio unavailable.')).toBeVisible()
  await expect(page.locator('#build-summary')).toHaveCount(0)
  await page.getByRole('button', { name: /Set a new starting portfolio from Sample portfolio/ }).click()
  await expect(page.locator('#build-summary')).toBeVisible()
  await expect(page.getByText(/New starting portfolio from Sample portfolio as of Nov 24\. The original wasn’t saved/)).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))).toBeNull()
})

test('reference sources: automatic, listed for the assets this portfolio holds, with readable provider names', async ({ page }) => {
  await start(page, '/overview')
  await page.getByRole('button', { name: 'Settings' }).click()
  const dlg = page.getByRole('dialog', { name: 'Settings' })
  // No source selectors: rates are chosen automatically, with details collapsed and readable provider names.
  await expect(dlg.getByLabel('Stablecoin reference source')).toHaveCount(0)
  await expect(dlg.getByLabel('Exchange rates in use')).toBeHidden()
  await dlg.getByText('Rates in use').click()
  const legs = dlg.getByLabel('Exchange rates in use')
  await expect(legs).toContainText('USDC to USD1.0000, Kraken')
  await expect(legs).not.toContainText('pUSD') // the Sample portfolio holds no pUSD
  await expect(legs).not.toContainText('fallback')
  await expect(dlg).toContainText('Sample rates. They are fixed, not live.')
})
