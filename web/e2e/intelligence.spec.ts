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

test('overview: native assets in coverage, no provenance strip, and the market-price display preference', async ({ page }) => {
  await fresh(page, '/overview')
  // Healthy data: no valuation or exchange-rate strip; the only issue shown is the out-of-date Kalshi source.
  await expect(page.getByLabel('Valuation basis')).toHaveCount(0)
  await expect(page.locator('.hero-card')).not.toContainText('1 USDC =')
  await expect(page.getByLabel('Data issues')).toHaveText('Kalshi data from Nov 22')
  // Native amounts keep their own units where several assets meet.
  await expect(page.locator('#coverage')).toContainText('24,768.00 USDC')
  await expect(page.locator('#coverage')).toContainText('USD')
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
  await page.getByRole('button', { name: 'Start Historical Replay' }).click()
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
  await page.locator('#rp-results').getByText('Exchange rates').click()
  await expect(page.locator('#rp-results')).toContainText('Combined using rates saved on')
  await expect(page.locator('#rp-results')).toContainText('1 USDC = 1 USD.')
  await expect(page.locator('#rp-results')).not.toContainText('Uses your own rates')
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

test('information hierarchy: no generic disclaimers on dashboards; modes, policies and methodology stay reachable', async ({ page }) => {
  for (const path of ['/overview', '/analytics', '/risk', '/scenario-lab', '/scenario-lab/replay?new=1', '/portfolio/accounts', '/portfolio/transactions']) {
    await fresh(page, path)
    const main = page.locator('main')
    await expect(main.locator('.footer-note, .asof')).toHaveCount(0)
    const text = await main.innerText()
    for (const generic of [/investment advice/i, /never places trades/i, /how likely/i, /1 USDC =/, / · /, / — /, /\bn ?= ?\d/]) expect(text, `${path}: ${generic}`).not.toMatch(generic)
  }
  // The data mode is identified once, at the workspace and market-data level.
  await fresh(page, '/overview')
  await expect(page.getByRole('button', { name: /^Portfolio: Sample portfolio/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Data status/ })).toContainText('Fixed sample')
  await page.goto('/scenario-lab')
  await expect(page.locator('main .head-row')).toContainText('Sample market data')
  await page.goto('/scenario-lab/replay?new=1')
  await expect(page.locator('main .caps')).toContainText('Sample market data')
  // Material qualification stays next to the inputs it qualifies.
  await expect(page.locator('main')).toContainText('Hindsight analysis. Entry and exit prices are your assumptions, not recorded fills.')
  // Product statements and methodology live in Help, organized by concept.
  await page.getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menu', { name: 'Help' }).getByRole('menuitem', { name: 'About Scevia' }).click()
  const help = page.getByRole('dialog', { name: 'Help' })
  await help.getByRole('tab', { name: 'About' }).click()
  await expect(help).toContainText('Scevia is read-only. It never places trades, holds funds or asks for private keys or seed phrases.')
  await expect(help).toContainText('not forecasts, recommendations or investment advice')
  await help.getByRole('tab', { name: 'Methodology' }).click()
  for (const section of ['Portfolio valuation', 'Performance', 'Risk', 'Scenario Lab', 'Historical Replay', 'Data coverage', 'Currency conversion']) await expect(help.getByRole('region', { name: section })).toBeVisible()
  await expect(help.getByRole('region', { name: 'Risk' })).toContainText('Worst-case settlement P&L')
  await page.keyboard.press('Escape')
  // The privacy dialog describes the actual portfolio and capabilities.
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Data & privacy' }).click()
  const privacy = page.getByRole('dialog', { name: 'Data & privacy' })
  await expect(privacy).toContainText('Sample portfolio (fictional sample data)')
  await expect(privacy).toContainText('None. This portfolio doesn’t use your accounts.')
  await expect(privacy).not.toContainText('Polymarket, Kalshi or other account')
})

test('information hierarchy: another fictional portfolio is still marked as sample data', async ({ page }) => {
  await devFresh(page, '/overview')
  await selectWorkspace(page, /Development fixture B/)
  // Its name doesn't say "sample", so the mode is shown next to it.
  await expect(page.getByRole('button', { name: /^Portfolio:/ }).locator('.chip-mode')).toHaveText('Sample')
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Data & privacy' }).click()
  await expect(page.getByRole('dialog', { name: 'Data & privacy' })).toContainText('Development fixture B (fictional sample data)')
})

/* Punctuation and spacing in rendered copy. Checked line by line on visible text, so data such as market titles is
   included but code never is; the sample's names and titles contain none of these patterns. */
const COPY_RULES: [string, RegExp][] = [
  ['space before punctuation', /[^\s] [,.;:](?=\s|$)/],
  ['double space', /\S {2,}\S/],
  ['empty parentheses', /\(\s*\)/],
  ['repeated punctuation', /(?<!\.)[,;:]{2,}|, ?,|[^.]\.\.(?!\.)/],
  ['semicolon in prose', /[A-Za-z’)%]; /],
  ['separator dot', / · /],
  ['em-dash separator', / — /],
  ['n = notation', /\bn ?= ?\d/],
  ['leading punctuation', /^\s*[,.;:]/],
  ['missing space after punctuation', /[a-z][,.;][A-Z][a-z]/],
  ['wrong plural', /(^|[^\d.,])1 (positions|events|trades|days|records|markets|contracts|fills|settlements|dates|rows)\b/],
]
const expectCleanCopy = async (loc: import('@playwright/test').Locator, where: string) => {
  const lines = (await loc.innerText()).split('\n')
  const bad = lines.flatMap((l) => COPY_RULES.filter(([, re]) => re.test(l)).map(([name]) => `${name}: “${l.trim()}”`))
  expect(bad, where).toEqual([])
}
const devFresh = async (page: Page, path: string, fx = '') => {
  await page.goto(path)
  await page.evaluate((v) => { sessionStorage.clear(); sessionStorage.setItem('scevia-dev-workspaces', '1'); if (v) sessionStorage.setItem('scevia-dev-fx', v) }, fx)
  await page.goto(path)
}
const selectWorkspace = async (page: Page, name: RegExp) => {
  await page.getByRole('button', { name: /^Portfolio:/ }).click()
  await page.getByRole('menuitemradio', { name }).click()
  await expect(page.getByRole('button', { name: /^Portfolio:/ })).toHaveAccessibleName(name)
}
const setCurrency = async (page: Page, code: string) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByLabel('Reporting currency').selectOption(code)
  return page.getByRole('dialog', { name: 'Settings' })
}

test('titles: each module has one plain title and no eyebrow that repeats it', async ({ page }) => {
  for (const [path, title] of [['/overview', 'Portfolio overview'], ['/analytics', 'Portfolio performance'], ['/risk', 'Portfolio risk'], ['/scenario-lab', 'Scenario Lab'], ['/scenario-lab/replay', 'Historical Replay']]) {
    await fresh(page, path)
    await expect(page.locator('main h1').first()).toHaveText(title)
    for (const eyebrow of await page.locator('main .page-head .caps').allInnerTexts()) expect(eyebrow.trim().toLowerCase()).not.toBe(title.toLowerCase())
  }
  // A specific replay is titled by its own name.
  await fresh(page, '/scenario-lab/replay?new=1')
  await expect(page.locator('main h1').first()).toContainText('Historical replay 1')
})

test('copy: saved cards, price check, replay errors and notifications read cleanly in every state', async ({ page }) => {
  // A scratch scenario that needs more virtual funds than it has.
  await fresh(page, '/scenario-lab')
  await page.getByLabel('Starting capital on Polymarket').fill('10')
  await page.getByRole('button', { name: 'Build from scratch' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add markets' })
  await dlg.getByLabel('Search markets').fill('Ethereum')
  await expectCleanCopy(dlg, 'add markets')
  await dlg.getByRole('button', { name: /Select Ethereum above \$5,000 on Dec 31 YES/ }).click()
  await dlg.getByRole('button', { name: 'Add 1 position' }).click()
  await page.getByLabel('Target shares of Ethereum above $5,000 on Dec 31').fill('5000')
  await page.getByLabel('Assumed price for Ethereum above $5,000 on Dec 31').fill('0.2')
  await expectCleanCopy(page.locator('main'), 'scratch scenario with a shortfall')
  // A current-portfolio scenario with its price check.
  await page.getByRole('option', { name: /All scenarios/ }).click()
  await page.getByRole('button', { name: 'Modify current portfolio' }).click()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Check latest' }).click()
  const check = page.getByRole('dialog', { name: 'Check latest prices' })
  await expect(check.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(check).toContainText('no positions with reference prices to check')
  await expectCleanCopy(check, 'price check')
  await page.keyboard.press('Escape')
  // Saved cards show the value and each status as its own label.
  await page.getByRole('option', { name: /All scenarios/ }).click()
  const card = page.getByRole('button', { name: 'Open From scratch' })
  await expect(card.locator('.scn-v')).toContainText('portfolio value')
  await expect(card.locator('.scn-flags')).toContainText('Needs funding')
  await expectCleanCopy(page.locator('main'), 'Scenario Lab entry with saved cards')
  // Historical Replay with a validation error.
  await page.goto('/scenario-lab/replay?new=1')
  await page.getByRole('button', { name: 'Add markets…' }).first().click()
  const rd = page.getByRole('dialog', { name: 'Add markets' })
  await rd.getByLabel('Search markets').fill('Fed cuts')
  await rd.getByRole('group', { name: /Fed cuts rates/ }).first().getByRole('button', { name: /NO$/ }).click()
  await expectCleanCopy(rd, 'replay picker')
  await rd.getByRole('button', { name: /^Add 1 position/ }).click()
  await page.getByRole('group', { name: /^Position 1/ }).getByLabel('Entry date').fill('2026-03-01')
  await expect(page.getByRole('group', { name: /^Position 1/ }).getByRole('alert')).toBeVisible()
  await expectCleanCopy(page.locator('main'), 'replay with errors')
  // Notifications.
  await page.getByRole('button', { name: /Notifications/ }).click()
  await expectCleanCopy(page.getByRole('menu').first(), 'notifications')
})

test('copy: the same pages read cleanly for another portfolio with one account in pUSD', async ({ page }) => {
  await devFresh(page, '/overview')
  await selectWorkspace(page, /Development fixture B/)
  for (const path of ['/overview', '/analytics', '/risk', '/scenario-lab', '/portfolio/accounts', '/portfolio/coverage']) {
    await page.getByRole('navigation').first().waitFor()
    await page.goto(path)
    await page.locator('main h1').first().waitFor()
    await expectCleanCopy(page.locator('main'), `fixture B ${path}`)
  }
  // Nothing in this portfolio is held in USDC, so only its own asset's rate is listed.
  const settings = await setCurrency(page, 'GBP')
  await settings.getByText('Rates in use').click()
  await expect(settings.getByLabel('Exchange rates in use')).toContainText('pUSD to USD')
  await expect(settings.getByLabel('Exchange rates in use')).not.toContainText('USDC')
  await expect(settings.getByLabel('Exchange rates in use')).toContainText('USD to GBP')
})

test('exchange rates: stale, missing and other providers are presented from the active rate service', async ({ page }) => {
  // Stale fiat rate: one specific warning, and the note next to figures says so.
  await devFresh(page, '/overview', 'stale')
  let s = await setCurrency(page, 'EUR')
  await expect(s.getByRole('status').filter({ hasText: 'rate is out of date' })).toHaveText('The USD to EUR rate is out of date (last observed Oct 1, 2026).')
  await expectCleanCopy(s, 'settings with a stale rate')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByLabel('Data issues')).toContainText('USD to EUR rate out of date')
  // Missing rates: a missing USD to EUR leg falls back to USD; a missing pUSD leg can't be converted at all.
  await devFresh(page, '/overview', 'missing')
  await selectWorkspace(page, /Development fixture B/)
  s = await setCurrency(page, 'EUR')
  const warnings = s.locator('.set-warn li')
  await expect(warnings).toHaveText(['No pUSD to USD rate is available, so totals that include pUSD can’t be converted.', 'No USD to EUR rate is available, so values are shown in USD.'])
  await expectCleanCopy(s, 'settings with missing rates')
  // The affected figure says so too: the total is partial without a pUSD rate.
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByLabel('Data issues')).toContainText('Partial total: no pUSD to USD rate')
  await expect(page.getByLabel('Data issues')).toContainText('Shown in USD: no USD to EUR rate')
  // Other providers: names come from the references, not from a fixed list.
  await devFresh(page, '/overview', 'alt')
  s = await setCurrency(page, 'GBP')
  await s.getByText('Rates in use').click()
  const legs = s.getByLabel('Exchange rates in use')
  await expect(legs).toContainText('USDC to USD1.0000, Example Stablecoin Index')
  await expect(legs).toContainText('USD to GBP0.7900, Example Fiat Reference')
  await expect(legs).not.toContainText(/Kraken|ECB|CoinGecko/)
})

test('analytics depth: performance, attribution, trading patterns and trade analysis keep one scope', async ({ page }) => {
  await fresh(page, '/analytics')
  const rail = page.getByRole('complementary', { name: 'Sections on this page' })
  for (const s of ['Performance', 'Attribution', 'Trading patterns', 'Trade analysis']) await expect(rail.getByRole('link', { name: s, exact: true })).toBeVisible()
  // Flow-adjusted return is labelled as an estimate; metrics without evidence say why instead of showing a number.
  await expect(page.locator('#highlights')).toContainText('Time-weighted return')
  await expect(page.locator('#highlights')).toContainText('est.')
  const ret = page.locator('#returns')
  await expect(ret).toContainText('Needs dated investor cash flows from the accounting service')
  await expect(ret).toContainText('Needs daily valuations')
  await ret.getByRole('tab', { name: 'Drawdown' }).click()
  await expect(ret.locator('svg')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Monthly returns' }).getByRole('listitem').first()).toHaveAccessibleName(/partial month/)
  // Attribution keeps fees separate and drills down with the page scope.
  await page.getByRole('radiogroup', { name: 'Group by' }).getByRole('radio', { name: 'Side' }).click()
  await expect(page.locator('#attribution thead')).toContainText('Fees')
  await expect(page.locator('#attribution tfoot')).toContainText('Change in unrealized')
  await page.locator('#attribution tbody tr').first().click()
  await expect(page.getByRole('dialog')).toContainText(/closed trades/)
  await page.keyboard.press('Escape')
  // Patterns: any dimension, precise cohorts, sample-size qualification, hindsight only where it applies.
  const pat = page.locator('#patterns')
  await expect(pat.getByRole('columnheader', { name: 'Win rate vs. entry price' })).toBeVisible()
  await pat.getByLabel('Group trades by').selectOption('Exit type')
  await expect(pat).toContainText('Sold before resolution')
  await expect(pat.locator('tbody tr', { hasText: 'Sold before resolution' })).toContainText('No resolved trades')
  await expect(pat.locator('.foot')).toContainText('In hindsight')
  await pat.getByLabel('Group trades by').selectOption('Holding period')
  await expect(pat.locator('.foot')).toHaveCount(0)
  await expect(pat).toContainText('Limited sample size')
  await pat.locator('tbody tr').first().click()
  await expect(page.getByRole('dialog')).toContainText(/^Holding period:/)
  await page.keyboard.press('Escape')
  // Trade analysis.
  await expect(page.locator('#largest .list-btn').first()).toBeVisible()
  await page.locator('#largest').getByRole('tab', { name: 'Largest losses' }).click()
  await expect(page.locator('#largest .list-btn').first().locator('.loss')).toBeVisible()
  await expect(page.locator('#activity')).toContainText('of entry notional')
  await expectCleanCopy(page.locator('main'), 'analytics')
})

test('analytics depth: a portfolio without closed trades shows empty states, not zeros', async ({ page }) => {
  await devFresh(page, '/overview')
  await selectWorkspace(page, /Development fixture B/)
  await page.getByRole('link', { name: 'Analytics' }).click()
  await expect(page.locator('#attribution')).toContainText('No trades closed in this period.')
  await expect(page.locator('#patterns')).toContainText('No trades closed in this period.')
  await expect(page.locator('#trades')).toContainText('No trades closed in this period.')
  await expectCleanCopy(page.locator('main'), 'analytics, fixture B')
})

test('risk depth: basis, concentration metrics, same-path settlement and resolution windows', async ({ page }) => {
  await fresh(page, '/risk')
  const conc = page.locator('#conc')
  await expect(conc.locator('.conc-stats')).toContainText('HHI')
  await expect(conc.locator('.conc-stats')).toContainText('Effective events')
  const costTop = await conc.locator('.conc-stats dd').first().innerText()
  await conc.getByRole('radiogroup', { name: 'Concentration basis' }).getByRole('radio', { name: 'Market value' }).click()
  await expect(conc).toContainText('Market value of open positions')
  await expect(conc.getByRole('button', { name: /Edit \d+% limit/ })).toHaveCount(0)
  expect(await conc.locator('.conc-stats dd').first().innerText()).not.toBe(costTop)
  await page.getByRole('radiogroup', { name: 'Group by' }).getByRole('radio', { name: 'By account' }).click()
  await expect(conc).toContainText('Account concentration')
  await expect(conc.locator('.conc-stats')).toContainText('Effective accounts')
  // The worst-path contributions add up to the worst-case tile: one joint outcome, not each event's own worst.
  const tile = await page.locator('.tile', { hasText: 'Worst-case settlement P&L' }).locator('.v').innerText()
  const st = page.locator('#settlement')
  await expect(st.locator('.settle-stats')).toContainText(tile)
  await expect(st.locator('.foot')).toContainText('One feasible joint outcome of')
  await st.getByRole('tab', { name: 'Best case' }).click()
  await expect(st.locator('.settle-stats')).not.toContainText(tile)
  // Relationships summarize classifications without implying independence; timing keeps windows apart.
  await expect(page.locator('#rel .rel-sum')).toContainText('unclassified pair')
  const timing = page.getByRole('list', { name: 'Capital committed by resolution window' })
  await expect(timing.getByRole('listitem').first()).toContainText('Within 30 days')
  await expectCleanCopy(page.locator('main'), 'risk')
})
