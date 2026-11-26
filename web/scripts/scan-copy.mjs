/* Copy scan of the rendered UI: walks pages, dialogs and conditional states and reports punctuation and spacing
   defects in visible text (space before a comma or full stop, doubled spaces, empty parentheses, repeated
   punctuation, semicolons, separator dots, em-dash separators, n = notation, a comma or full stop at the start of a
   line). User-entered names and market titles in this sample don't contain such characters, so any hit is copy.
   Usage: node scripts/scan-copy.mjs <baseURL> */
import { chromium } from '@playwright/test'

const base = process.argv[2] ?? 'http://localhost:5173'
const RULES = [
  ['space before punctuation', /[^\s] [,.;:](?=\s|$)/],
  ['double space', /\S {2,}\S/],
  ['empty parentheses', /\(\s*\)/],
  ['repeated punctuation', /(?<!\.)[,;:]{2,}|\.\.(?!\.)|, ?,/],
  ['semicolon', /[A-Za-z’)%]; /],
  ['separator dot', / · /],
  ['em-dash separator', / — /],
  ['n = notation', /\bn ?= ?\d/],
  ['leading punctuation', /^[,.;:]/m],
  ['missing space after punctuation', /[a-z][,.;][A-Z][a-z]/],
]
const hits = new Map()
const check = async (p, where) => {
  const text = await p.evaluate(() => [...document.querySelectorAll('main, [role="dialog"], [role="menu"], [role="listbox"], [role="status"]')].map((e) => e.innerText).join('\n'))
  for (const line of text.split('\n')) for (const [name, re] of RULES) if (re.test(line)) {
    const k = `${name}: ${line.trim().slice(0, 160)}`
    if (!hits.has(k)) hits.set(k, where)
  }
}
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const go = async (path, devWs = false) => {
  await p.goto(base + path); await p.evaluate((d) => { sessionStorage.clear(); if (d) sessionStorage.setItem('scevia-dev-workspaces', '1') }, devWs); await p.goto(base + path)
  await p.locator('main').first().waitFor(); await p.waitForTimeout(300)
}
const tryClick = async (loc) => { try { await loc.first().click({ timeout: 2000 }); await p.waitForTimeout(250); return true } catch { return false } }

for (const path of ['/overview', '/analytics', '/risk', '/scenario-lab', '/scenario-lab/replay?new=1', '/portfolio/accounts', '/portfolio/sources', '/portfolio/transactions', '/portfolio/imports', '/portfolio/coverage']) {
  await go(path); await check(p, path)
}
// Overview on one platform, details panels, analytics drill-down.
await go('/overview')
if (await tryClick(p.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: /Kalshi/ }))) await check(p, 'overview kalshi')
await go('/overview'); if (await tryClick(p.locator('#holdings tbody tr button, #holdings tbody tr a'))) { await check(p, 'position detail'); await p.keyboard.press('Escape') }
await go('/risk'); if (await tryClick(p.locator('#concentration [role="button"], #concentration button'))) { await check(p, 'event detail'); await p.keyboard.press('Escape') }
await go('/analytics'); if (await tryClick(p.locator('#by-category button, .seg-row button, [aria-label*="View trades"]'))) { await check(p, 'trades drill-down'); await p.keyboard.press('Escape') }
// Shell utilities.
await go('/overview')
for (const name of [/^Portfolio:/, /^Data status/, /Notifications/, 'Help']) { if (await tryClick(p.getByRole('button', { name }))) { await check(p, `menu ${name}`); await p.keyboard.press('Escape') } }
if (await tryClick(p.getByRole('button', { name: 'Settings' }))) {
  await tryClick(p.getByText('Rates in use')); await check(p, 'settings general')
  for (const tab of ['Analytics', 'Risk', 'Scenario Lab', 'Notifications']) { await tryClick(p.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: tab })); await check(p, `settings ${tab}`) }
  await p.keyboard.press('Escape')
}
await p.keyboard.press('Meta+k'); await p.keyboard.type('bitcoin'); await p.waitForTimeout(300); await check(p, 'search'); await p.keyboard.press('Escape')
// Scenario Lab: current portfolio scenario, analysis, price check, add markets, scratch with shortfall.
await go('/scenario-lab')
await tryClick(p.getByRole('button', { name: 'Modify current portfolio' })); await check(p, 'scenario build')
if (await tryClick(p.getByRole('button', { name: 'Add markets…' }))) {
  await p.getByLabel('Search markets').fill('Fed').catch(() => {}); await p.waitForTimeout(400); await check(p, 'add markets'); await p.keyboard.press('Escape')
}
if (await tryClick(p.getByRole('button', { name: 'Check latest' }))) { await p.waitForTimeout(400); await check(p, 'price check'); await p.keyboard.press('Escape') }
await tryClick(p.getByRole('tab', { name: /^Analyze/ })); await check(p, 'scenario analyze')
await tryClick(p.getByRole('tab', { name: /^Compare/ })); await check(p, 'scenario compare')
await go('/scenario-lab')
await p.getByLabel('Starting capital on Polymarket').fill('10').catch(() => {})
await tryClick(p.getByRole('button', { name: 'Build from scratch' }).last()); await check(p, 'scratch build')
if (await tryClick(p.getByRole('button', { name: 'Add markets…' }))) {
  await p.getByLabel('Search markets').fill('Bitcoin').catch(() => {}); await p.waitForTimeout(400)
  await tryClick(p.getByRole('dialog').getByRole('button', { name: /YES$/ })); await tryClick(p.getByRole('dialog').getByRole('button', { name: /^Add / }))
}
await p.locator('input[aria-label^="Target"]').first().fill('5000').catch(() => {}); await p.waitForTimeout(300); await check(p, 'scratch with shortfall')
await go('/scenario-lab'); await check(p, 'lab home with saved')
// Historical Replay: validation errors, unfunded and analyzed states.
await go('/scenario-lab/replay?new=1')
if (await tryClick(p.getByRole('button', { name: 'Add markets…' }))) {
  await p.getByLabel('Search markets').fill('Fed').catch(() => {}); await p.waitForTimeout(400); await check(p, 'replay picker')
  await tryClick(p.getByRole('dialog').getByRole('button', { name: /YES$/ })); await tryClick(p.getByRole('dialog').getByRole('button', { name: /^Add \d/ }))
}
await p.locator('#rp-setup').getByLabel('Start', { exact: true }).fill('2026-01-01').catch(() => {}); await p.waitForTimeout(300); await check(p, 'replay errors')
await tryClick(p.getByRole('button', { name: 'Analyze replay' })); await check(p, 'replay analyze')
// Development workspaces: failed, slow and demo states.
await go('/overview', true)
for (const ws of [/Development fixture B/, /Development fixture D/, /Demo portfolio/]) {
  if (await tryClick(p.getByRole('button', { name: /^Portfolio:/ }))) { await tryClick(p.getByRole('menuitemradio', { name: ws })); await p.waitForTimeout(800); await check(p, `workspace ${ws}`) }
}
await browser.close()
if (hits.size === 0) console.log('copy scan: no issues')
else { for (const [k, w] of hits) console.log(`${w}  |  ${k}`); console.log(`copy scan: ${hits.size} issue(s)`) }
