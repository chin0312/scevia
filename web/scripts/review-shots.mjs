/* Visual review: captures the pages and flows reviewed for a change, at the widths listed in the review checklist.
   Usage: node scripts/review-shots.mjs <baseURL> <outDir> [before]
   Uses only the sample portfolio and sample market data. */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const [base = 'http://localhost:5173', out = 'review-shots', mode = 'after'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
const shot = async (page, name, full = true) => { await page.waitForTimeout(350); await page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 72, fullPage: full }) }
const fresh = async (page, path) => { await page.goto(base + path); await page.evaluate(() => sessionStorage.clear()); await page.goto(base + path); await page.locator('main h1').first().waitFor() }

async function at(width, height, fn) {
  const page = await browser.newPage({ viewport: { width, height } })
  try { await fn(page) } finally { await page.close() }
}

if (mode === 'before') {
  await at(1440, 900, async (p) => { await fresh(p, '/scenario-lab'); await shot(p, 'before-lab-empty-1440') })
  await at(1440, 900, async (p) => {
    await fresh(p, '/scenario-lab')
    await p.getByRole('button', { name: 'Start from current portfolio' }).click(); await p.keyboard.press('Enter')
    await p.getByRole('button', { name: 'Add position…' }).first().click(); await p.getByRole('button', { name: 'Add 2026 hottest year on record YES' }).click()
    await p.getByLabel('Target shares of 2026 hottest year on record').fill('2000')
    await shot(p, 'before-lab-scenario-1440')
  })
  await at(375, 812, async (p) => { await fresh(p, '/scenario-lab'); await p.getByRole('button', { name: 'Start from current portfolio' }).click(); await p.keyboard.press('Enter'); await shot(p, 'before-lab-scenario-375') })
} else {
  const example = async (p) => { await fresh(p, '/scenario-lab'); await p.locator('.home-ex').getByRole('button', { name: 'Trim crypto, add to Fed' }).click(); await p.locator('#positions').waitFor() }
  await at(1440, 900, async (p) => { await fresh(p, '/scenario-lab'); await shot(p, 'after-lab-entry-1440') })
  for (const [w, h] of [[375, 812], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]]) {
    await at(w, h, async (p) => { await example(p); await shot(p, `after-build-${w}`) })
  }
  await at(1440, 900, async (p) => {
    await fresh(p, '/scenario-lab')
    await p.getByLabel('Starting capital on Polymarket').fill('6000'); await p.getByLabel('Starting capital on Kalshi').fill('4000')
    await p.getByRole('button', { name: 'Build from scratch' }).click()
    const dlg = p.getByRole('dialog', { name: 'Add markets' })
    await dlg.getByLabel('Search markets').fill('Fed')
    await dlg.getByRole('button', { name: /Select Fed cuts rates at Jan 2027 FOMC YES/ }).click()
    await dlg.getByRole('button', { name: /Select Fed holds rates at Jan 2027 FOMC NO/ }).click()
    await dlg.getByLabel('Search markets').fill('Ethereum')
    await dlg.getByRole('button', { name: /Select Ethereum above \$5,000 on Dec 31 YES/ }).click()
    await dlg.getByLabel('Search markets').fill('Lakers')
    await dlg.getByRole('button', { name: /Select Lakers win 2027 Finals YES/ }).click()
    await shot(p, 'after-add-markets-multiselect-1440', false)
    await dlg.getByRole('button', { name: 'Add 4 positions' }).click()
    await p.getByRole('radiogroup', { name: 'Size positions by' }).getByRole('radio', { name: '$ Amount' }).click()
    const amounts = { 'Fed cuts rates at Jan 2027 FOMC': '1500', 'Fed holds rates at Jan 2027 FOMC': '1000', 'Ethereum above $5,000 on Dec 31': '2000', 'Lakers win 2027 Finals': '500' }
    for (const [m, v] of Object.entries(amounts)) { await p.getByLabel(`Target amount for ${m}`).fill(v); await p.locator('.brow', { hasText: m }).getByRole('button', { name: /Use reference/ }).click() }
    await shot(p, 'after-scratch-build-1440')
    await p.getByRole('tab', { name: /^Analyze/ }).click(); await shot(p, 'after-scratch-analyze-1440')
  })
  await at(1440, 900, async (p) => {
    await example(p)
    await p.getByRole('button', { name: 'Edit assumptions' }).click(); await shot(p, 'after-assumptions-drawer-1440', false)
    await p.keyboard.press('Escape')
    await p.getByRole('tab', { name: /^Analyze/ }).click(); await shot(p, 'after-analyze-1440')
  })
  await at(375, 812, async (p) => { await example(p); await p.getByRole('tab', { name: /^Analyze/ }).click(); await shot(p, 'after-analyze-375') })
  await at(1920, 1080, async (p) => {
    await example(p)
    await p.getByRole('option', { name: /All scenarios/ }).click()
    await p.getByLabel('Starting capital on Polymarket').fill('10000')
    await p.getByRole('button', { name: 'Build from scratch' }).click()
    const dlg = p.getByRole('dialog', { name: 'Add markets' })
    await dlg.getByLabel('Search markets').fill('Ethereum'); await dlg.getByRole('button', { name: /Select Ethereum above \$5,000 on Dec 31 YES/ }).click()
    await dlg.getByRole('button', { name: 'Add 1 position' }).click()
    await p.getByLabel('Target shares of Ethereum above $5,000 on Dec 31').fill('20000'); await p.getByRole('button', { name: /Use reference/ }).click()
    await p.getByRole('tab', { name: /^Compare/ }).click(); await shot(p, 'after-compare-1920')
  })
  await at(1440, 900, async (p) => {
    await fresh(p, '/accounts'); await shot(p, 'after-records-1440')
    await p.getByLabel('Select all records on this page').check(); await p.getByRole('button', { name: /Select all 21 matching/ }).click()
    await p.getByRole('toolbar', { name: 'Selected records' }).getByRole('button', { name: 'Exclude…' }).click(); await shot(p, 'after-records-bulk-preview-1440', false)
    await p.keyboard.press('Escape')
    await p.getByRole('button', { name: 'Clear selection' }).click()
    await p.getByRole('button', { name: 'Import CSV…' }).click()
    const dlg = p.getByRole('dialog', { name: 'Import a CSV file' })
    await dlg.getByRole('button', { name: 'Continue' }).click(); await dlg.getByRole('button', { name: 'Continue' }).click()
    await shot(p, 'after-records-import-preview-1440', false)
  })
  await at(375, 812, async (p) => { await fresh(p, '/accounts'); await shot(p, 'after-records-375') })
  for (const path of ['overview', 'analytics', 'risk']) await at(1440, 900, async (p) => { await fresh(p, `/${path}`); await shot(p, `after-${path}-1440`) })
}
await browser.close()
console.log('done')
