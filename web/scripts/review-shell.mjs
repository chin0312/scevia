/* Visual review of the workspace shell: toolbar utilities, portfolio workspace, search, help, notifications,
   settings and account, at the reviewed widths. Usage: node scripts/review-shell.mjs <baseURL> <outDir> [before] */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const [base = 'http://localhost:5173', out = 'review-shots', mode = 'after'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
const shot = async (p, name, full = false) => { await p.waitForTimeout(300); await p.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 72, fullPage: full }) }
const fresh = async (p, path) => { await p.goto(base + path); await p.evaluate(() => sessionStorage.clear()); await p.goto(base + path); await p.locator('main h1').first().waitFor() }
async function at(w, h, fn) { const p = await browser.newPage({ viewport: { width: w, height: h } }); try { await fn(p) } finally { await p.close() } }
const menu = async (p, name, file) => { await p.getByRole('button', { name }).first().click(); await shot(p, file); await p.keyboard.press('Escape') }

if (mode === 'before') {
  await at(1440, 900, async (p) => {
    await fresh(p, '/overview')
    for (const [n, f] of [[/^Portfolio/, 'before-menu-portfolio'], [/^Help$/, 'before-menu-help'], [/^Notifications/, 'before-menu-notifications'], [/^Profile$/, 'before-menu-profile']]) await menu(p, n, f)
    await p.getByRole('button', { name: 'Settings' }).click(); await shot(p, 'before-settings'); await p.keyboard.press('Escape')
    await p.keyboard.press('ControlOrMeta+k'); await p.keyboard.type('bitcoin'); await shot(p, 'before-search'); await p.keyboard.press('Escape')
    await fresh(p, '/accounts'); await shot(p, 'before-records', true)
  })
  await at(375, 812, async (p) => { await fresh(p, '/overview'); await shot(p, 'before-toolbar-375') })
} else {
  for (const [w, h] of [[375, 812], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]]) await at(w, h, async (p) => {
    await fresh(p, '/overview'); await shot(p, `after-toolbar-${w}`)
    await menu(p, /^Portfolio/, `after-menu-portfolio-${w}`)
  })
  await at(1440, 900, async (p) => {
    await fresh(p, '/overview')
    for (const [n, f] of [[/^Help$/, 'after-menu-help'], [/^Notifications/, 'after-menu-notifications'], [/^Account$/, 'after-menu-account']]) await menu(p, n, f)
    await p.getByRole('button', { name: 'Settings' }).click(); await shot(p, 'after-settings-general')
    await p.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Notifications' }).click(); await shot(p, 'after-settings-notifications'); await p.keyboard.press('Escape')
    await p.keyboard.press('ControlOrMeta+k'); await shot(p, 'after-search-empty'); await p.keyboard.type('bitcoin'); await shot(p, 'after-search-bitcoin'); await p.keyboard.press('Escape')
    await p.getByRole('button', { name: /^Help$/ }).click(); await p.getByRole('menuitem', { name: 'Methodology & glossary' }).click(); await shot(p, 'after-help-methodology'); await p.keyboard.press('Escape')
    await p.getByRole('button', { name: /^Account$/ }).click(); await p.getByRole('menuitem', { name: 'Data & privacy' }).click(); await shot(p, 'after-privacy'); await p.keyboard.press('Escape')
    for (const s of ['accounts', 'sources', 'transactions', 'imports', 'coverage']) { await p.goto(`${base}/portfolio/${s}`); await p.locator('main h1').waitFor(); await shot(p, `after-portfolio-${s}`, true) }
    await p.goto(`${base}/portfolio/transactions`); await p.getByLabel('Select all records on this page').check(); await p.getByRole('button', { name: /Select all 21 matching/ }).click()
    await p.getByRole('toolbar', { name: 'Selected records' }).getByRole('button', { name: 'Exclude…' }).click(); await shot(p, 'after-bulk-preview'); await p.keyboard.press('Escape')
    await p.getByRole('button', { name: 'Clear selection' }).click()
    await p.locator('.rec-table tbody tr', { hasText: 'Fed rate cut' }).first().getByRole('button', { name: /Fed rate cut/ }).click(); await shot(p, 'after-record-detail'); await p.keyboard.press('Escape')
    await p.getByRole('button', { name: 'Add record…' }).click(); await shot(p, 'after-manual-record'); await p.keyboard.press('Escape')
    await p.getByRole('button', { name: 'Import CSV…' }).first().click(); const d = p.getByRole('dialog', { name: 'Import a CSV file' })
    await d.getByRole('button', { name: 'Continue' }).click(); await d.getByRole('button', { name: 'Continue' }).click(); await shot(p, 'after-import-preview')
  })
  await at(375, 812, async (p) => {
    await fresh(p, '/portfolio/transactions'); await shot(p, 'after-portfolio-transactions-375', true)
    await menu(p, /^Notifications/, 'after-menu-notifications-375')
    await menu(p, /^Account$/, 'after-menu-account-375')
  })
  for (const path of ['overview', 'analytics', 'risk', 'scenario-lab']) await at(1440, 900, async (p) => { await fresh(p, `/${path}`); await shot(p, `after-regression-${path}`, true) })
}
await browser.close()
console.log('done')
