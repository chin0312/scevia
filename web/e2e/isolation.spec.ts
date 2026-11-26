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
  await expect(page.getByLabel('Valuation basis')).toContainText('PUSD')

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
  await expect(page.getByRole('listbox', { name: 'Results' })).toContainText('Scenario · from Sample portfolio')
  await page.keyboard.press('Escape')
  await page.goto('/scenario-lab')
  await expect(page.getByText(/Starts from Sample portfolio as of Nov 24, frozen/)).toBeVisible()

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
  await expect(dlg.getByText('found, not priced yet')).toBeVisible()
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
  await page.getByLabel('Reporting currency').selectOption('SGD')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('1 USD = 1.3400 SGD')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('Not a live rate')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.hero-fig')).toContainText('S$')
  await expect(page.locator('.hero-fig')).toContainText('SGD')
  await expect(page.getByLabel('Valuation basis')).toContainText('24,768.00 USDC')
  await expect(page.getByLabel('Valuation basis')).toContainText('In SGD')
  await page.reload()
  await expect(page.locator('.hero-fig')).toContainText('SGD')
  await page.getByRole('button', { name: /^Data status/ }).click()
  await expect(page.getByRole('menu', { name: 'Data status' })).toContainText('Exchange rates')
})
