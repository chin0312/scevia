/* Workspace boundary, data freshness, history periods, current-market price references and Historical Replay. */
import { expect, test, type Page } from '@playwright/test'

const fresh = async (page: Page, path: string) => {
  await page.goto(path)
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(path)
}
const portfolioMenu = async (page: Page) => { await page.getByRole('button', { name: /^Portfolio:/ }).click(); return page.getByRole('menu', { name: 'Portfolio' }) }

test('workspaces: Sample, Demo and own portfolios are distinct; switching keeps other work', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Modify current portfolio' }).click()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Untitled scenario')

  const menu = await portfolioMenu(page)
  await expect(menu.getByRole('menuitemradio', { name: /Sample portfolio/ })).toHaveAttribute('aria-checked', 'true')
  await expect(menu).toContainText('Fictional markets and records')
  await expect(menu).toContainText('Real markets, virtual capital')
  await expect(menu).toContainText('My portfolios')
  await expect(menu.getByRole('menuitem', { name: /Create portfolio/ })).toBeDisabled()
  await expect(menu).toContainText('Polymarket USDC')
  await expect(menu).toContainText('Kalshi USD')
  await menu.getByRole('menuitemradio', { name: /Demo portfolio/ }).click()

  // The Scenario Lab collection is the user's, not the portfolio's: the scenario stays, on its frozen Sample start.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Untitled scenario')
  await expect(page.getByText(/Starts from Sample portfolio as of Nov 24\. That portfolio isn’t selected now/)).toBeVisible()
  await page.getByRole('option', { name: /All scenarios/ }).click()
  await expect(page.getByRole('button', { name: 'Modify current portfolio' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Build from scratch' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Data status: Unavailable' })).toBeVisible()
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(page.getByRole('menu', { name: 'Notifications' })).toContainText('No notifications for this portfolio.')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Search Scevia' }).fill('bitcoin')
  await expect(page.getByRole('listbox', { name: 'Results' })).not.toContainText('Bitcoin above')
  await page.keyboard.press('Escape')

  // The demo has no approved real-market data here: an explicit state, never the fictional sample in its place.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Overview' }).click()
  await expect(page.getByRole('heading', { name: 'Demo portfolio isn’t available' })).toBeVisible()
  await page.getByRole('button', { name: 'Open Sample portfolio' }).click()
  await expect(page.getByRole('heading', { name: 'Portfolio overview' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Scenario Lab' }).click()
  await expect(page.getByRole('button', { name: 'Open Untitled scenario' })).toBeVisible()
})

test('data status: streams are reported separately; refresh keeps filters and inputs', async ({ page }) => {
  await fresh(page, '/analytics')
  const pill = page.getByRole('button', { name: 'Data status: Fixed sample' })
  await expect(pill).toBeVisible()
  await page.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: /Kalshi/ }).click()
  await page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: '1Y' }).click()
  await pill.click()
  const menu = page.getByRole('menu', { name: 'Data status' })
  for (const s of ['Market data', 'Account data', 'Portfolio valuation', 'Historical coverage', 'Background sync', 'Source connections']) await expect(menu).toContainText(s)
  await expect(menu).not.toContainText('Streaming')
  await expect(menu).toContainText('Not checked in this tab yet')
  await menu.getByRole('menuitem', { name: 'Refresh now' }).click()
  await expect(page.getByText('Checked. The sample portfolio has no new data')).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: /Kalshi/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: '1Y' })).toHaveAttribute('aria-checked', 'true')
  // The menu stays open after refreshing and reports the check.
  await expect(menu).toContainText(/Last checked just now, no new data/)
})

test('analytics: presets follow history coverage; a custom range is validated before it applies', async ({ page }) => {
  await fresh(page, '/analytics')
  const period = page.getByRole('radiogroup', { name: 'Period' })
  for (const p of ['1W', '1M', '3M', '6M', 'YTD', '1Y', 'All']) await expect(period.getByRole('radio', { name: p, exact: true })).toBeEnabled()
  await expect(page.getByText(/History from Jan 6, 2025/)).toBeVisible()
  await period.getByRole('radio', { name: 'Custom' }).click()
  const form = page.getByRole('form', { name: 'Custom period' })
  await form.getByLabel('From').fill('2026-06-01')
  await form.getByLabel('To').fill('2026-05-01')
  await form.getByRole('button', { name: 'Apply' }).click()
  await expect(form.getByRole('alert')).toHaveText('The end date must be after the start date.')
  await form.getByLabel('From').fill('2024-01-01'); await form.getByLabel('To').fill('2026-03-01')
  await form.getByRole('button', { name: 'Apply' }).click()
  await expect(form.getByRole('alert')).toContainText('History starts on')
  await form.getByLabel('From').fill('2026-01-01')
  await form.getByRole('button', { name: 'Apply' }).click()
  await expect(page.locator('main .page-head')).toContainText('Jan 2, 2026 – Mar 1, 2026')
})

test('overview: valuation basis, native assets and the market-price display preference', async ({ page }) => {
  await fresh(page, '/overview')
  const basis = page.getByLabel('Valuation basis')
  await expect(basis).toContainText('Prices as of Nov 24, 2026')
  await expect(basis).toContainText('USDC')
  await expect(basis).toContainText('USD')
  await expect(basis).toContainText('Shown in USD (1 USDC = 1.0000 USD)')
  await expect(page.getByRole('columnheader', { name: 'Entry → Price' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('radiogroup', { name: 'Market prices' }).getByRole('radio', { name: '64%' }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('columnheader', { name: 'Entry → Implied' })).toBeVisible()
  await expect(page.locator('#holdings tbody tr').first()).toContainText('%')
})

test('scenario prices: frozen references are checked against the latest without changing assumptions', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.locator('.home-ex').getByRole('button').first().click()
  await page.getByRole('group', { name: 'Scenario assumptions' }).getByRole('button', { name: 'Check latest' }).click()
  const dlg = page.getByRole('dialog', { name: 'Check latest prices' })
  await expect(dlg).toContainText('No reference price has moved since this scenario started')
  await expect(dlg.getByRole('columnheader', { name: 'Your assumed price' })).toBeVisible()
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(dlg).toHaveCount(0)
})

test('historical replay: virtual funding, trading-close validation, funding status, repeated positions and compare', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Start a historical replay' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Historical replay 1')
  await expect(page.getByText('No virtual funds yet.')).toBeVisible()
  await page.locator('#rp-setup').getByLabel('Start', { exact: true }).fill('2026-03-01')

  await page.getByRole('button', { name: 'Add markets…' }).first().click()
  const dlg = page.getByRole('dialog', { name: 'Add markets' })
  await expect(dlg).toContainText('Sample market data.')
  await dlg.getByRole('button', { name: 'Select Incumbent wins Springfield mayoral election YES' }).click()
  await dlg.getByRole('button', { name: 'Select Fed cuts rates at Jan 2027 FOMC YES' }).click()
  await dlg.getByRole('button', { name: 'Add 2 positions' }).click()
  // Virtual funding for each venue is offered automatically; no account is involved.
  await expect(page.getByLabel('Starting capital, Polymarket USDC')).toBeVisible()
  await expect(page.getByLabel('Starting capital, Kalshi USD')).toBeVisible()
  await page.getByLabel('Starting capital, Polymarket USDC').fill('1000')
  await page.getByLabel('Starting capital, Kalshi USD').fill('100')

  const mayor = page.getByRole('group', { name: /^Position \d: Incumbent wins/ })
  await mayor.getByLabel('Entry price').fill('0.6')
  await mayor.getByLabel('Amount').fill('300')
  await mayor.getByRole('radiogroup', { name: /Exit for/ }).getByRole('radio', { name: 'Sell on date' }).click()
  await mayor.getByLabel('Exit date').fill('2026-11-05')
  await mayor.getByLabel('Exit price').fill('0.9')
  // Trading closed on Nov 4; the Nov 5 resolution doesn't extend it.
  await expect(mayor.getByRole('alert')).toHaveText('Trading closed on Nov 4, 2026. It resolved later, on Nov 5, 2026. Hold to settlement instead.')
  await mayor.getByRole('radiogroup', { name: /Exit for/ }).getByRole('radio', { name: 'Hold to settlement' }).click()

  const fed = page.getByRole('group', { name: /^Position 2: Fed cuts rates/ })
  await fed.getByRole('radiogroup', { name: /Outcome for/ }).getByRole('radio', { name: 'NO' }).click()
  await fed.getByLabel('Entry date').fill('2026-04-01')
  await fed.getByLabel('Entry price').fill('0.5')
  await fed.getByLabel('Amount').fill('200')
  await expect(fed.getByRole('alert')).toHaveText('This market wasn’t listed until May 1, 2026.')
  await expect(page.getByRole('button', { name: 'Analyze replay' })).toBeDisabled()
  await fed.getByLabel('Entry date').fill('2026-06-01')
  await expect(fed).toContainText('Trading close isn’t recorded')
  // A second position in the same market (YES this time).
  await fed.getByRole('button', { name: /Add another position in Fed cuts/ }).click()
  const fed2 = page.getByRole('group', { name: /^Position 3: Fed cuts rates/ })
  await fed2.getByRole('radiogroup', { name: /Outcome for/ }).getByRole('radio', { name: 'YES' }).click()
  await fed2.getByLabel('Entry price').fill('0.3')
  await fed2.getByLabel('Amount').fill('30')
  await expect(page.locator('#rp-setup')).toContainText('Funding shortfall')
  await page.getByRole('button', { name: 'Analyze replay' }).click()

  await expect(page.getByText('Not enough virtual funds.')).toBeVisible()
  await expect(page.locator('#rp-results')).toContainText('Ending value in USD (not enough virtual funds)')
  await page.getByRole('button', { name: /^Add 13[0-9] USD$/ }).first().click()
  await expect(page.getByText('Not enough virtual funds.')).toHaveCount(0)
  const lines = page.locator('#rp-lines')
  await expect(lines).toContainText('Resolved YES')
  await expect(lines).toContainText('+194.00 USDC')
  await expect(lines).toContainText('Open, observed')
  await expect(page.locator('#rp-value')).toContainText('Value over time is unavailable')
  // Combined reporting uses reference rates automatically; an override is an explicit, labelled hypothetical rate.
  await expect(page.locator('#rp-results')).toContainText('Combined using rates saved on')
  await expect(page.locator('#rp-results')).toContainText('1 USDC = 1 USD. Sample rates.')
  await expect(page.locator('#rp-results')).not.toContainText('Uses your own rates')
  await page.locator('#rp-results').getByText('Use your own rates').click()
  await page.getByLabel('USD per 1 USDC').fill('0.9')
  await expect(page.locator('#rp-results')).toContainText('Uses your own rates.')

  await page.getByRole('button', { name: 'Duplicate' }).click()
  await page.getByRole('tablist', { name: 'Replay views' }).getByRole('tab', { name: /^Build/ }).click()
  await page.getByLabel('Starting capital, Polymarket USDC').fill('2000')
  await page.getByRole('tablist', { name: 'Replay views' }).getByRole('tab', { name: /^Compare/ }).click()
  await expect(page.locator('#rp-compare')).toContainText('These replays differ in: starting capital')
  await expect(page.locator('#rp-compare')).toContainText('A normalized performance chart needs a complete value history')
  await expect(page.locator('#rp-compare')).toContainText('not comparable')

  await page.goto('/scenario-lab')
  await expect(page.getByRole('button', { name: 'Open Historical replay 1', exact: true })).toContainText('Historical replay')
})

test('simulation without any portfolio: scratch and replay work with virtual capital only', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByRole('button', { name: /^Portfolio:/ }).click()
  await page.getByRole('menuitemradio', { name: /Demo portfolio/ }).click()
  await expect(page.getByRole('button', { name: 'Modify current portfolio' })).toBeDisabled()
  await page.getByLabel('Starting capital on Kalshi').fill('500')
  await page.getByRole('button', { name: 'Build from scratch' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add markets' })
  await expect(dlg).toBeVisible()
  await dlg.getByRole('tab', { name: 'Search markets' }).click()
  await expect(dlg.getByText('Fed cuts rates at Jan 2027 FOMC').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('From scratch')
  await page.goto('/scenario-lab/replay?new=1')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Historical replay')
  await page.getByRole('button', { name: 'Add markets…' }).first().click()
  await page.getByRole('dialog', { name: 'Add markets' }).getByRole('button', { name: 'Select Fed cuts rates at Jan 2027 FOMC YES' }).click()
  await page.getByRole('dialog', { name: 'Add markets' }).getByRole('button', { name: 'Add 1 position' }).click()
  await expect(page.getByLabel('Starting capital, Kalshi USD')).toBeVisible()
})

test('responsive: the selector, data status and replay build fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await fresh(page, '/overview')
  await expect(page.getByRole('button', { name: /^Portfolio:/ })).toBeVisible()
  await page.getByRole('button', { name: /^Data status/ }).click()
  const box = await page.getByRole('menu', { name: 'Data status' }).boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^Data status/ })).toBeFocused()
  await page.goto('/scenario-lab/replay?new=1')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Historical replay')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('copy: plain sentences on every page, with the critical disclosures kept once', async ({ page }) => {
  const pages: [string, string[]][] = [
    ['/overview', ['Sample portfolio (fictional data)', 'Scevia is read-only. It never places trades or holds funds.']],
    ['/analytics', ['Portfolio performance', 'They don’t predict future ones and aren’t investment advice.']],
    ['/risk', ['Scevia does not estimate how likely each outcome is.']],
    ['/scenario-lab', ['Simulate portfolios with virtual money. Nothing here places a trade or touches your accounts.']],
    ['/scenario-lab/replay?new=1', ['You choose these markets knowing how they turned out.', 'It isn’t your actual performance or a tested strategy.']],
    ['/portfolio/accounts', ['Sample portfolio (fictional data)']],
  ]
  for (const [path, disclosures] of pages) {
    await fresh(page, path)
    const main = page.locator('main')
    for (const d of disclosures) await expect(main).toContainText(d)
    const text = await main.innerText()
    expect(text, `${path} uses separator dots`).not.toMatch(/ · /)
    expect(text, `${path} uses statistical notation`).not.toMatch(/\bn ?= ?\d/)
    expect(text, `${path} uses em-dash separators`).not.toMatch(/ — /)
  }
})
