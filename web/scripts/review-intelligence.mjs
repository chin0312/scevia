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
  await p.getByLabel('Starting capital in Wallet 0x7a…c2 (USDC)').fill('1000')
  await p.getByLabel('Starting capital in Main account (USD)').fill('500')
  await p.locator('#rp-setup').getByLabel('Start', { exact: true }).fill('2026-03-01')
  await p.getByRole('button', { name: 'Add markets…' }).first().click()
  const dlg = p.getByRole('dialog', { name: 'Add markets' })
  await dlg.getByRole('checkbox', { name: /Incumbent wins Springfield/ }).check()
  await dlg.getByRole('checkbox', { name: /Fed cuts rates at Jan 2027 FOMC/ }).check()
  await dlg.getByRole('button', { name: 'Add 2 markets' }).click()
  const mayor = p.getByRole('group', { name: 'Incumbent wins Springfield mayoral election YES' })
  await mayor.getByLabel('Execution price').fill('0.6'); await mayor.getByLabel('Amount').fill('300')
  const fed = p.getByRole('group', { name: 'Fed cuts rates at Jan 2027 FOMC YES' })
  await fed.getByRole('radiogroup', { name: /Outcome for/ }).getByRole('radio', { name: 'NO' }).click()
  const fedNo = p.getByRole('group', { name: 'Fed cuts rates at Jan 2027 FOMC NO' })
  await fedNo.getByLabel('Entry date').fill('2026-04-01'); await fedNo.getByLabel('Execution price').fill('0.5'); await fedNo.getByLabel('Amount').fill('200')
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
  await p.getByRole('group', { name: 'Fed cuts rates at Jan 2027 FOMC NO' }).getByLabel('Entry date').fill('2026-06-01')
  await shot(p, 'replay-build', true)
  await p.getByRole('button', { name: 'Analyze replay' }).click(); await shot(p, 'replay-analyze', true)
  await p.getByRole('button', { name: 'Duplicate' }).click()
  await p.getByRole('tablist', { name: 'Replay views' }).getByRole('tab', { name: /^Build/ }).click()
  await p.getByLabel('Starting capital in Wallet 0x7a…c2 (USDC)').fill('2000')
  await p.getByRole('tablist', { name: 'Replay views' }).getByRole('tab', { name: /^Compare/ }).click(); await shot(p, 'replay-compare', true)
})
await browser.close()
console.log('done')
