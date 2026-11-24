import { expect, test, type Page } from '@playwright/test'
import { POS_BY_ID, account, periodRange, periodStats } from '../src/lib/finance'
import { fmt, sfmt } from '../src/lib/format'

const fresh = async (page: Page, path: string) => {
  await page.goto(path)
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(path)
}

test('1 · view a position in Overview and open it in Scenario Lab', async ({ page }) => {
  await fresh(page, '/overview')
  const p = POS_BY_ID.shut
  await page.getByRole('row', { name: `${p.market}: open details` }).click()
  const drawer = page.getByRole('dialog', { name: p.market })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Weighted average')).toBeVisible()
  await expect(drawer.getByText(fmt(p.cost, 2)).first()).toBeVisible()
  await drawer.getByRole('button', { name: 'Simulate a change' }).click()
  await expect(page).toHaveURL(/scenario-lab/)
  await expect(page.getByRole('slider', { name: `Target shares of ${p.market}` })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(p.market)
})

test('2 · adjusting a scenario updates results; invalid input is caught', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  const cashRow = page.locator('#ba .ba-row', { hasText: /^Cash/ })
  const before = await cashRow.locator('.after').innerText()
  const shares = page.getByLabel('Target shares', { exact: true }).first()
  await shares.fill('0') // first adjustment: BTC → full exit
  await expect(cashRow.locator('.after')).not.toHaveText(before)
  await expect(page.getByText('Exit', { exact: true }).first()).toBeVisible()

  const price = page.getByLabel('Hypothetical price ($)').first()
  await price.fill('1.5')
  await expect(page.getByRole('alert').first()).toContainText('between $0.01 and $0.99')
  await expect(page.getByRole('button', { name: /Save scenario|Saved/ })).toBeDisabled()
  await price.fill('0.30')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled()
})

test('2b · buying more than a platform’s cash is flagged', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Add position' }).click()
  await page.getByRole('menuitem', { name: /2026 hottest year on record/ }).click()
  const hot = POS_BY_ID.hot, target = hot.shares + 5000
  expect((target - hot.shares) * hot.mark).toBeGreaterThan(account('ks').cash) // the sample makes this unaffordable
  await page.locator('#sh-hot').fill(String(target))
  await expect(page.getByRole('alert').first()).toContainText('Not enough Kalshi cash')
  await expect(page.getByRole('button', { name: 'Save scenario' })).toBeDisabled()
})

test('3 · an event relationship changes Risk and Scenario Lab consistently', async ({ page }) => {
  await fresh(page, '/risk#rel')
  await page.getByRole('button', { name: 'Classify' }).click()
  const dialog = page.getByRole('dialog', { name: 'Classify relationship' })
  await dialog.getByText('Mutually exclusive outcomes').click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('#payoffs .foot')).toContainText('combinations excluded')

  await page.getByRole('link', { name: 'Scenario Lab' }).click()
  await page.getByLabel('First event').selectOption('eth')
  await page.getByLabel('Second event').selectOption('btc')
  await expect(page.locator('#matrix').getByText('Mutually exclusive outcomes')).toBeVisible()
  await expect(page.locator('#matrix').getByText('Not possible')).toHaveCount(1)
})

test('4 · switching platform and period keeps summaries consistent', async ({ page }) => {
  await fresh(page, '/overview')
  await page.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: /Polymarket/ }).click()
  await expect(page.getByText('Sample portfolio: Polymarket only')).toBeVisible()
  const pm = account('pm')
  const [i, d] = pm.totalValue.toFixed(2).split('.')
  await expect(page.locator('.hero-fig')).toContainText(`$${Number(i).toLocaleString('en-US')}`)
  await expect(page.locator('.hero-fig')).toContainText(`.${d}`)
  await expect(page.getByText(fmt(pm.committed), { exact: true })).toBeVisible()

  await page.goto('/analytics')
  await page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: '1M' }).click()
  const s = periodStats('all', periodRange('1M'))
  await expect(page.locator('.summary')).toContainText(sfmt(s.netPnl, 2))
  await expect(page.locator('#highlights')).toContainText(sfmt(s.netPnl))
  await page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: 'All', exact: true }).click()
  await expect(page.getByRole('button', { name: 'No prior period' })).toBeDisabled()
})

test('demo onboarding never claims a real connection', async ({ page }) => {
  await fresh(page, '/overview')
  await page.getByRole('button', { name: 'Data sources (demo)' }).first().click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Demo only')
  await dlg.getByText('Preview: Polymarket public wallet').click()
  await expect(page.getByLabel('Wallet address')).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Run sample coverage check' }).click()
  await expect(page.getByRole('dialog', { name: 'Coverage check · sample result' })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('status')).toContainText('Nothing was connected')
})

test('modal keeps focus inside and returns it to the trigger', async ({ page }) => {
  await fresh(page, '/risk')
  const trigger = page.getByRole('button', { name: 'Edit 15% guardrail' })
  await trigger.click()
  await expect(page.getByLabel('Guardrail percent')).toBeFocused()
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})
