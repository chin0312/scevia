/* Visual review of the portfolio selector, data status, Overview freshness and holdings, Analytics coverage, the
   Scenario Lab entry, frozen vs. latest prices and Historical Replay (Build, Analyze, Compare).
   Usage: node scripts/review-intelligence.mjs <baseURL> <outDir> */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const [base = 'http://localhost:5173', out = 'review-shots'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
const shot = async (p, name, full = false) => { await p.waitForTimeout(350); await p.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 72, fullPage: full }) }
const fresh = async (p, path) => { await p.goto(base + path); await p.evaluate(() => sessionStorage.clear()); await p.goto(base + path); await p.locator('main h1').first().waitFor() }
async function at(w, h, fn) { const p = await browser.newPage({ viewport: { width: w, height: h } }); try { await fn(p) } finally { await p.close() } }

async function buildReplay(p) {
  await fresh(p, '/scenario-lab/replay?new=1')
  await p.locator('#rp-setup').getByLabel('Start', { exact: true }).fill('2026-03-01')
  await p.getByRole('button', { name: 'Add markets…' }).first().click()
  const dlg = p.getByRole('dialog', { name: 'Add markets' })
  await dlg.getByRole('button', { name: 'Select Incumbent wins Springfield mayoral election YES' }).click()
  await dlg.getByRole('button', { name: 'Select Fed cuts rates at Jan 2027 FOMC YES' }).click()
  await dlg.getByRole('button', { name: 'Add 2 positions' }).click()
  await p.getByLabel('Starting capital, Polymarket USDC').fill('1000')
  await p.getByLabel('Starting capital, Kalshi USD').fill('100')
  const mayor = p.getByRole('group', { name: /^Position \d: Incumbent wins/ })
  await mayor.getByLabel('Entry price').fill('0.6'); await mayor.getByLabel('Amount').fill('300')
  const fed = p.getByRole('group', { name: /^Position 2: Fed cuts rates/ })
  await fed.getByRole('radiogroup', { name: /Outcome for/ }).getByRole('radio', { name: 'NO' }).click()
  await fed.getByLabel('Entry date').fill('2026-04-01'); await fed.getByLabel('Entry price').fill('0.5'); await fed.getByLabel('Amount').fill('200')
}

for (const [w, h] of [[375, 812], [768, 1024], [1440, 900]]) await at(w, h, async (p) => {
  await fresh(p, '/overview'); await shot(p, `toolbar-${w}`)
  await p.getByRole('button', { name: /^Portfolio:/ }).click(); await shot(p, `portfolio-selector-${w}`); await p.keyboard.press('Escape')
  await p.getByRole('button', { name: /^Data status/ }).click(); await shot(p, `data-status-${w}`); await p.keyboard.press('Escape')
  await fresh(p, '/scenario-lab'); await shot(p, `lab-entry-${w}`, true)
  await buildReplay(p); await shot(p, `replay-build-invalid-${w}`, true)
})
await at(1440, 900, async (p) => {
  await fresh(p, '/overview')
  await p.getByRole('button', { name: /^Portfolio:/ }).click(); await p.getByRole('menuitemradio', { name: /Demo portfolio/ }).click()
  await p.getByRole('heading', { name: 'Demo portfolio isn’t available' }).waitFor(); await shot(p, 'demo-unavailable')
  await fresh(p, '/overview'); await shot(p, 'overview-hero')
  await p.locator('#holdings').scrollIntoViewIfNeeded(); await shot(p, 'overview-holdings')
  await fresh(p, '/analytics'); await shot(p, 'analytics-coverage')
  await p.getByRole('radiogroup', { name: 'Period' }).getByRole('radio', { name: 'Custom' }).click(); await shot(p, 'analytics-custom')
  await fresh(p, '/risk'); await shot(p, 'risk-basis')
  await fresh(p, '/scenario-lab'); await p.locator('.home-ex').getByRole('button').first().click()
  await shot(p, 'scenario-assumptions')
  await p.getByRole('button', { name: 'Check latest' }).click(); await p.getByRole('dialog', { name: 'Check latest prices' }).getByRole('table').waitFor(); await shot(p, 'scenario-price-check')
  await buildReplay(p)
  await p.getByRole('group', { name: /^Position 2: Fed cuts rates/ }).getByLabel('Entry date').fill('2026-06-01')
  await shot(p, 'replay-build', true)
  await p.getByRole('button', { name: 'Analyze replay' }).click(); await shot(p, 'replay-analyze-unfunded', true)
  await p.getByRole('button', { name: /^Add \d+ USD$/ }).first().click(); await shot(p, 'replay-analyze', true)
  await p.getByRole('button', { name: 'Duplicate' }).click()
  await p.getByRole('tablist', { name: 'Replay views' }).getByRole('tab', { name: /^Build/ }).click()
  await p.getByLabel('Starting capital, Polymarket USDC').fill('2000')
  await p.getByRole('tablist', { name: 'Replay views' }).getByRole('tab', { name: /^Compare/ }).click(); await shot(p, 'replay-compare', true)
})
// Workspace isolation (development-only service): another portfolio's figures, a failed refresh, the Demo in Scenario Lab.
await at(1440, 900, async (p) => {
  await p.goto(base + '/overview'); await p.evaluate(() => { sessionStorage.clear(); sessionStorage.setItem('scevia-dev-workspaces', '1') }); await p.goto(base + '/overview')
  await p.getByRole('button', { name: /^Portfolio:/ }).click(); await shot(p, 'isolation-selector')
  await p.getByRole('menuitemradio', { name: /Development fixture B/ }).click()
  await p.locator('#holdings').waitFor(); await shot(p, 'isolation-fixture-b')
  await p.getByRole('button', { name: /^Portfolio:/ }).click(); await p.getByRole('menuitemradio', { name: /Development fixture D/ }).click()
  await p.locator('#holdings').waitFor()
  await p.getByRole('button', { name: /^Data status/ }).click(); await p.getByRole('menuitem', { name: 'Refresh now' }).click(); await p.getByText('it isn’t newly synchronized').waitFor(); await shot(p, 'refresh-failed')
  await p.keyboard.press('Escape')
  await p.getByRole('button', { name: /^Portfolio:/ }).click(); await p.getByRole('menuitemradio', { name: /Demo portfolio/ }).click()
  await p.goto(base + '/scenario-lab'); await p.locator('main h1').first().waitFor(); await shot(p, 'demo-scenario-lab', true)
})
// Reporting currency, discovery, independent Scenario Lab collection.
await at(1440, 900, async (p) => {
  await p.goto(base + '/overview'); await p.evaluate(() => { sessionStorage.clear(); sessionStorage.setItem('scevia-dev-workspaces', '1') }); await p.goto(base + '/overview')
  await p.getByRole('button', { name: 'Settings' }).click(); await p.getByLabel('Reporting currency').selectOption('EUR'); await shot(p, 'settings-reporting-currency')
  await p.getByRole('dialog', { name: 'Settings' }).getByText('Rates in use').click(); await shot(p, 'settings-fx-rates-in-use')
  await p.keyboard.press('Escape'); await p.locator('.hero-fig').waitFor(); await shot(p, 'overview-eur')
  await p.goto(base + '/scenario-lab/replay?new=1'); await p.getByRole('button', { name: 'Add markets…' }).first().click()
  const rd = p.getByRole('dialog', { name: 'Add markets' }); await rd.getByLabel('Search markets').fill('Brent')
  await rd.getByRole('button', { name: 'Select Brent above $90 on Mar 31 NO' }).click(); await rd.getByLabel('Search markets').fill('Copper'); await rd.getByRole('group', { name: 'Copper above $5 on Dec 31' }).waitFor(); await shot(p, 'replay-picker-denominations')
  await p.keyboard.press('Escape')
  await p.goto(base + '/scenario-lab'); await p.getByRole('button', { name: 'Modify current portfolio' }).click(); await p.keyboard.press('Enter')
  await p.getByRole('button', { name: 'Add markets…' }).first().click()
  const dlg = p.getByRole('dialog', { name: 'Add markets' }); await dlg.getByRole('tab', { name: 'Search markets' }).click(); await dlg.getByLabel('Search markets').fill('ECB')
  await dlg.getByText('ECB holds rates in Jan 2027').waitFor(); await shot(p, 'discovery-multi-market')
  await dlg.getByRole('tab', { name: 'Paste link' }).click(); await dlg.getByLabel('Market link').fill('https://kalshi.com/markets/kxscalar-27'); await dlg.getByRole('button', { name: 'Find market' }).click()
  await dlg.getByText(/market type isn’t supported/).waitFor(); await shot(p, 'discovery-unsupported'); await p.keyboard.press('Escape')
  await p.getByRole('button', { name: /^Portfolio:/ }).click(); await p.getByRole('menuitemradio', { name: /Development fixture B/ }).click()
  await p.goto(base + '/scenario-lab'); await p.getByText(/isn’t selected now/).first().waitFor(); await shot(p, 'scenario-frozen-other-portfolio')
})
await browser.close()
console.log('done')
