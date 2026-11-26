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
  await expect(page.getByRole('listbox', { name: 'Results' })).not.toContainText('Untitled scenario')
  await page.keyboard.press('Escape')
  await page.goto('/scenario-lab')
  await expect(page.getByText('Untitled scenario')).toHaveCount(0)

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
