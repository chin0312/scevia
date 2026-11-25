import { expect, test, type Page } from '@playwright/test'
import { POS_BY_ID, account, allocation, exposures, periodRange, periodStats, positionsFor } from '../src/lib/finance'
import { fmt, sfmt } from '../src/lib/format'

const fresh = async (page: Page, path: string) => {
  await page.goto(path)
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(path)
}
/** Scenario Lab starts empty; examples are created only when the user picks one. */
const startExample = async (page: Page, name: string) => {
  if (!page.url().includes('/scenario-lab')) await page.goto('/scenario-lab')
  await expect(page.locator('main h1')).toBeVisible()
  const onHome = page.locator('.home-ex').getByRole('button', { name })
  if (await onHome.count()) await onHome.click()
  else { await page.getByRole('button', { name: 'New scenario' }).click(); await page.getByRole('menuitem', { name }).click() }
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
}
const startCurrent = async (page: Page) => {
  await page.getByRole('button', { name: 'Modify current portfolio' }).click()
  await page.keyboard.press('Enter') // accept the default name
}
/** Build from scratch opens the market picker straight away. */
const startScratch = async (page: Page, close = true) => {
  await page.getByRole('button', { name: 'Build from scratch' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add markets' })
  await expect(dlg).toBeVisible()
  if (close) { await page.keyboard.press('Escape'); await expect(dlg).toHaveCount(0) }
  return dlg
}
const openAdd = async (page: Page) => { await page.getByRole('button', { name: 'Add markets…' }).first().click(); return page.getByRole('dialog', { name: 'Add markets' }) }
const addHeld = async (page: Page, ...ids: string[]) => {
  const dlg = await openAdd(page)
  for (const id of ids) await dlg.getByLabel(`Select ${POS_BY_ID[id].market} ${POS_BY_ID[id].side}`).check()
  await dlg.getByRole('button', { name: `Add ${ids.length} position${ids.length > 1 ? 's' : ''}` }).click()
}
const view = (page: Page, v: 'Build' | 'Analyze' | 'Compare') => page.getByRole('tablist', { name: 'Scenario views' }).getByRole('tab', { name: new RegExp(`^${v}`) }).click()
const summary = (page: Page, label: string | RegExp) => page.locator('#build-summary .bs-line', { hasText: label }).first().locator('.r')
const target = (page: Page, market: string) => page.getByLabel(`Target shares of ${market}`)
const rows = (page: Page) => page.locator('.builder .brow:not(.brow-h)')

test('1 · view a position in Overview, then add it to a scenario only after choosing where', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Exit sports longshots')
  await page.goto('/overview')
  const p = POS_BY_ID.shut
  await page.getByRole('row', { name: `${p.market}: open details` }).click()
  const drawer = page.getByRole('dialog', { name: p.market })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('Weighted average')).toBeVisible()
  await expect(drawer.getByText(fmt(p.cost, 2)).first()).toBeVisible()
  await drawer.getByRole('button', { name: 'Simulate in Scenario Lab' }).click()
  await expect(page).toHaveURL(/\/scenario-lab$/) // the request is consumed, so reload/Back can't re-add
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await expect(add).toContainText(p.market)
  await add.getByLabel('Target scenario').selectOption({ label: 'Exit sports longshots · 2 positions' })
  await add.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Exit sports longshots')
  // starts at the current holding and mark: nothing changes until the user edits it
  await expect(target(page, p.market)).toHaveValue(String(p.shares))
  await expect(page.locator('.brow', { hasText: p.market }).getByText('No change')).toBeVisible()
  await expect(page.getByRole('status')).toContainText(p.market)
})

test('1b · cancelling an incoming add changes no scenario; already-included positions are skipped', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Trim crypto, add to Fed')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))).not.toBeNull()
  const before = await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))
  await page.goto('/scenario-lab?addEvent=fed')
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await expect(add.getByRole('checkbox')).toHaveCount(2) // both Fed contracts, across platforms
  await add.getByRole('button', { name: 'Cancel' }).click()
  await expect(add).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))).toBe(before)

  await page.goto('/scenario-lab?add=fedk') // the draft already adjusts this contract
  await page.getByRole('dialog', { name: 'Add to a scenario' }).getByLabel('Target scenario').selectOption({ label: 'Trim crypto, add to Fed · 3 positions' })
  await expect(page.getByText('Already in this scenario: left as it is')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
})

test('2 · adjusting a scenario updates results; invalid input is caught', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Trim crypto, add to Fed')
  const cash = summary(page, 'Cash after trades')
  const before = await cash.innerText()
  await target(page, POS_BY_ID.btc.market).fill('0') // BTC → full exit
  await expect(cash).not.toHaveText(before)
  await expect(page.getByText('Exit', { exact: true }).first()).toBeVisible()

  const price = page.getByLabel(`Assumed price for ${POS_BY_ID.btc.market}`)
  await price.fill('1.5')
  await expect(page.getByRole('alert').first()).toContainText('between $0.01 and $0.99')
  await expect(page.getByRole('button', { name: /Save scenario|Saved/ })).toBeDisabled()
  await expect(page.getByRole('tab', { name: /^Build/ })).toContainText('1') // the Build view flags the incomplete row
  await price.fill('0.30')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled()
})

test('2b · a purchase beyond available cash is explored as a funded hypothetical, with the gap shown', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startCurrent(page)
  await addHeld(page, 'hot')
  const hot = POS_BY_ID.hot, to = hot.shares + 5000
  expect((to - hot.shares) * hot.mark).toBeGreaterThan(account('ks').cash)
  await target(page, hot.market).fill(String(to))
  await expect(page.locator('#build-summary')).toContainText(/Needs \$[\d,.]+ more on Kalshi/)
  await expect(page.getByText('Kalshi purchases exceed this scenario’s cash there; included as if funded.').first()).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0) // not an input error
  await expect(summary(page, 'Value at reference marks')).toContainText('$') // the trade is in the results
  await expect(page.getByRole('button', { name: 'Save scenario' })).toBeEnabled()
  // explicitly funding Kalshi removes the gap without counting the capital as a gain
  await page.getByLabel('Added capital on Kalshi').fill('10000')
  await expect(page.locator('#build-summary')).not.toContainText(/Needs \$/)
  await expect(summary(page, 'incl. added capital')).toHaveText('$10,000')
  await expect(page.locator('.assume-bar')).toContainText('$10,000')
})

test('2c · scenario create, rename, save and revert behave predictably', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Modify current portfolio' }).click()
  const name = page.getByLabel('Scenario name')
  await name.fill('Fed hedge')
  await name.press('Enter')
  await expect(page.locator('.page-head .caps')).toContainText('Not saved')
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await expect(page.locator('.page-head .caps')).toContainText('Saved')
  await page.getByRole('button', { name: 'Rename scenario' }).click()
  await page.getByLabel('Scenario name').fill('Fed hedge v2')
  await page.getByLabel('Scenario name').press('Enter')
  await expect(page.locator('.page-head .caps')).toContainText('Unsaved changes')
  await page.getByRole('button', { name: 'Revert' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Fed hedge')
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('v2')
  await expect(page.locator('.page-head .caps')).toContainText('Saved')
  // the entry page lists it for resuming
  await page.getByRole('option', { name: /All scenarios/ }).click()
  await expect(page.locator('#saved')).toContainText('Fed hedge')
  await page.getByRole('button', { name: 'Open Fed hedge' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Fed hedge')
})

test('3 · a hypothetical settlement constraint changes only its own scenario; Risk stays factual', async ({ page }) => {
  await fresh(page, '/risk#rel')
  await expect(page.locator('#rel')).not.toContainText('BTC')
  await expect(page.locator('#rel')).toContainText('not correlation')
  const riskWorst = await page.locator('.tile', { hasText: 'Worst feasible outcome' }).locator('.v').innerText()
  await page.getByRole('link', { name: 'Scenario Lab' }).click()
  await startCurrent(page)
  await page.getByRole('button', { name: 'Edit assumptions' }).click()
  const drawer = page.getByRole('dialog', { name: 'Scenario assumptions' })
  await drawer.getByLabel('Constraint: first event').selectOption({ label: 'Bitcoin above $150k, Dec 31' })
  await drawer.getByLabel('Constraint: second event').selectOption({ label: 'ETH ETF inflows > $1B (Nov)' })
  await drawer.getByRole('button', { name: 'Add constraint' }).click()
  await expect(drawer).toContainText('this scenario only')
  await drawer.getByLabel('Constraint: first event').selectOption({ label: 'Bitcoin above $150k, Dec 31' })
  await drawer.getByLabel('Constraint: second event').selectOption({ label: 'ETH ETF inflows > $1B (Nov)' })
  await expect(drawer.getByRole('button', { name: 'Add constraint' })).toBeDisabled() // duplicate pair
  await page.keyboard.press('Escape')
  await expect(page.locator('.assume-bar')).toContainText('1 hypothetical')
  await view(page, 'Analyze')
  await page.getByLabel('First event', { exact: true }).selectOption('eth')
  await page.getByLabel('Second event', { exact: true }).selectOption('btc')
  await expect(page.locator('#matrix').getByText('Mutually exclusive outcomes')).toBeVisible()
  await expect(page.locator('#matrix').getByText('Not possible')).toHaveCount(1)
  await view(page, 'Compare')
  await expect(page.locator('#c-table')).toContainText('Hypothetical constraints')
  await page.getByRole('link', { name: 'Risk' }).click()
  await expect(page.locator('.tile', { hasText: 'Worst feasible outcome' }).locator('.v')).toHaveText(riskWorst)
  await expect(page.locator('#payoffs .foot')).not.toContainText('combinations excluded')
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

test('data sources never claim a connection; account actions are unavailable, not simulated', async ({ page }) => {
  await fresh(page, '/overview')
  await page.getByRole('button', { name: /Sample portfolio ·/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Data sources' })
  await expect(dlg).toContainText('Sample portfolio')
  await expect(dlg).toContainText('Active')
  await expect(dlg.getByText('Not connected')).toHaveCount(2)
  for (const b of await dlg.getByRole('button', { name: 'Connect' }).all()) await expect(b).toBeDisabled()
  await expect(dlg).not.toContainText(/demo|prototype|connected successfully/i)
})

test('Risk: table filters never change portfolio-level metrics', async ({ page }) => {
  await fresh(page, '/risk')
  const tile = page.locator('.tile', { hasText: 'Worst feasible outcome' }).locator('.v')
  const portfolioWorst = await tile.innerText()
  await page.getByRole('tab', { name: 'Next 30 days' }).click()
  await expect(tile).toHaveText(portfolioWorst)
  await expect(page.locator('#payoffs .po-row.t')).toContainText('shown (subtotal)')
  // make "Over guardrail" empty: raise the guardrail above every event
  await page.getByRole('button', { name: /Edit \d+% guardrail/ }).click()
  await page.getByLabel('Guardrail percent').fill('40')
  await page.getByRole('button', { name: 'Save guardrail' }).click()
  await page.getByRole('tab', { name: 'Over guardrail' }).click()
  await expect(page.locator('#payoffs')).toContainText('This filter only changes the table')
  await expect(page.locator('#payoffs')).toContainText(portfolioWorst)
  await expect(tile).toHaveText(portfolioWorst)
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

test('allocation: selecting a segment filters Holdings locally and survives scope changes honestly', async ({ page }) => {
  await fresh(page, '/overview')
  const hero = await page.locator('.hero-fig').innerText()
  const seg = allocation('all', 'category').segments[0]
  await page.locator('#allocation .al-btn', { hasText: seg.key }).click()
  await expect(page.locator('#allocation .al-btn', { hasText: seg.key })).toHaveAttribute('aria-pressed', 'true')
  const bar = page.locator('#holdings .filter-bar')
  await expect(bar).toContainText(`${seg.positions.length} of ${positionsFor('all').length} positions`)
  await expect(page.locator('#holdings tbody tr.clickable')).toHaveCount(seg.positions.length)
  await expect(page.locator('.hero-fig')).toHaveText(hero) // portfolio-wide figures never change
  await bar.getByRole('button', { name: 'Clear filter' }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.locator('#holdings tbody tr.clickable')).toHaveCount(positionsFor('all').length)

  // a Kalshi-only category, then switch the global scope to Polymarket
  const pmCats = new Set(positionsFor('pm').map((p) => p.category))
  const ksOnly = allocation('all', 'category').segments.find((x) => !pmCats.has(x.key as never))
  test.skip(!ksOnly, 'sample has no Kalshi-only category')
  await page.locator('#allocation .al-btn', { hasText: ksOnly!.key }).click()
  await page.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: /Polymarket/ }).click()
  await expect(bar).toContainText('so all positions are shown')
  await expect(page.locator('#holdings tbody tr.clickable')).toHaveCount(positionsFor('pm').length)
})

test('section rail: one active entry; an explicit choice survives reaching the bottom', async ({ page }) => {
  await fresh(page, '/risk')
  const rail = page.getByRole('complementary', { name: 'Sections on this page' })
  await rail.getByRole('link', { name: 'Event relationships' }).click()
  await expect(page).toHaveURL(/#rel$/)
  await expect(rail.getByRole('link', { name: 'Event relationships' })).toHaveAttribute('aria-current', 'location')
  await expect(page.locator('#rel')).toBeFocused()
  await page.waitForTimeout(800) // smooth scroll settles at the bottom of the page
  await expect(rail.getByRole('link', { name: 'Resolution calendar' })).not.toHaveAttribute('aria-current', 'location')
  await expect(rail.locator('[aria-current]')).toHaveCount(1)

  await rail.getByRole('link', { name: 'Downside ladder' }).click()
  await expect(rail.getByRole('link', { name: 'Downside ladder' })).toHaveAttribute('aria-current', 'location')
  await expect(rail.getByRole('link', { name: 'Concentration', exact: true })).not.toHaveAttribute('aria-current', 'location')
  await expect(rail.locator('[aria-current]')).toHaveCount(1)
})

test('inspecting stays in place: Overview schedule, Risk payoffs and search open panels, not other modules', async ({ page }) => {
  await fresh(page, '/overview')
  const scenarios = await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))
  const fed = exposures('all').find((e) => e.event.id === 'fed')!
  await page.getByRole('row', { name: `${POS_BY_ID.shut.market}: open details` }).focus()
  await page.keyboard.press('Enter') // keyboard opening must not also activate the panel's Close button
  await expect(page.getByRole('dialog', { name: POS_BY_ID.shut.market })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('#upcoming .tl-btn').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page).toHaveURL(/\/overview$/)
  await page.keyboard.press('Escape')

  await page.goto('/risk')
  await page.getByRole('button', { name: new RegExp(`^${fed.event.name}, 2 contracts`) }).click()
  const dlg = page.getByRole('dialog', { name: fed.event.name })
  for (const p of fed.positions) await expect(dlg).toContainText(p.market)
  await expect(page).toHaveURL(/\/risk$/)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: /Search pages, positions, events/ }).click()
  await page.getByLabel('Search pages, positions and events').fill(POS_BY_ID.shut.market)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: POS_BY_ID.shut.market })).toBeVisible()
  await expect(page).toHaveURL(/\/risk$/)
  expect(await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))).toBe(scenarios)
})

for (const vp of [{ name: 'phone', width: 375, height: 812 }, { name: 'tablet', width: 768, height: 1024 }]) {
  test(`${vp.name} layout: no page reaches past the viewport; sections stay reachable`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    for (const path of ['/overview', '/analytics', '/risk', '/scenario-lab']) {
      await page.goto(path)
      await expect(page.locator('main h1')).toBeVisible()
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(over, `${path} overflows by ${over}px`).toBeLessThanOrEqual(1)
      await expect(page.getByRole('complementary', { name: 'Sections on this page' }).getByRole('link').first()).toBeVisible()
    }
  })
}

test('platform badges use the official marks and keep their names for assistive tech', async ({ page }) => {
  await page.goto('/overview')
  const badge = page.locator('#holdings .plat').first()
  await expect(badge).toHaveAttribute('role', 'img')
  await expect(badge.locator('svg path')).toHaveCount(1)
  expect(await badge.getAttribute('aria-label')).toMatch(/^(Polymarket|Kalshi)$/)
})

const scenariosIn = (page: Page) => page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4'))
const settle = async (page: Page) => { await expect(page.locator('main h1')).toBeVisible(); await expect.poll(() => scenariosIn(page)).not.toBeNull() }

test('hand-offs: the same deliberate request can be repeated; cancel, Back and reload never mutate', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await settle(page)
  const before = await scenariosIn(page)
  const p = POS_BY_ID.shut
  const addViaSearch = async () => {
    await page.getByRole('button', { name: /Search pages, positions, events/ }).click()
    await page.getByLabel('Search pages, positions and events').fill(p.market)
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: p.market }).getByRole('button', { name: 'Add to a scenario…' }).click()
  }
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  for (let i = 0; i < 2; i++) { // same position, same page, twice
    await addViaSearch()
    await expect(add).toBeVisible()
    await expect(add).toContainText(p.market)
    await add.getByRole('button', { name: 'Cancel' }).click()
    await expect(add).toHaveCount(0)
  }
  expect(await scenariosIn(page)).toBe(before)
  await expect(page).toHaveURL(/\/scenario-lab$/)
  await page.reload()
  await settle(page)
  await expect(add).toHaveCount(0)
  await page.goBack()
  await page.goForward()
  await expect(add).toHaveCount(0)
  expect(await scenariosIn(page)).toBe(before)
})

test('hand-offs keep existing adjustments untouched', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Trim crypto, add to Fed')
  await settle(page)
  const slider = target(page, POS_BY_ID.fedk.market)
  await expect(slider).toHaveValue('6200')
  await page.goto('/overview')
  const row = page.getByRole('row', { name: `${POS_BY_ID.fedk.market}: open details` })
  await row.hover()
  await row.getByRole('button', { name: 'Simulate' }).click()
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await add.getByLabel('Target scenario').selectOption({ label: 'Trim crypto, add to Fed · 3 positions' })
  await expect(add.getByText('Already in this scenario: left as it is')).toBeVisible()
  await expect(add.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
  await add.getByRole('button', { name: 'Cancel' }).click()
  await expect(slider).toHaveValue('6200')
})

test('scope: an event opened from a Polymarket-only view starts in that scope and hands off only those holdings', async ({ page }) => {
  await fresh(page, '/overview')
  await page.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: /Polymarket/ }).click()
  await page.getByRole('button', { name: /Dec 2026 FOMC decision: view event exposure/ }).click()
  const dlg = page.getByRole('dialog', { name: 'Dec 2026 FOMC decision' })
  await expect(dlg.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'Polymarket only' })).toHaveAttribute('aria-checked', 'true')
  await expect(dlg).toContainText('You also hold this event on Kalshi')
  await expect(dlg).toContainText(fmt(POS_BY_ID.fedp.cost))
  await expect(dlg.getByRole('button', { name: `${POS_BY_ID.fedk.market}: open details` })).toHaveCount(0)
  await dlg.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'All platforms' }).click()
  await expect(dlg.getByRole('button', { name: `${POS_BY_ID.fedk.market}: open details` })).toBeVisible()
  await dlg.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: 'Polymarket only' }).click()
  await dlg.getByRole('button', { name: /Simulate in Scenario Lab/ }).click()
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await expect(add).toContainText('Polymarket only')
  await expect(add.getByRole('checkbox')).toHaveCount(1)
  await expect(add).toContainText(POS_BY_ID.fedp.market)
})

test('analytics drill-downs keep the period and platform scope', async ({ page }) => {
  await fresh(page, '/analytics')
  await page.getByRole('radiogroup', { name: 'Platform' }).getByRole('radio', { name: 'Kalshi' }).click()
  await page.locator('#attribution .attr-btn').first().click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText(periodRange('6M').label)
  await expect(dlg).toContainText('Kalshi')
  for (const b of await dlg.locator('.plat').all()) await expect(b).toHaveAttribute('aria-label', 'Kalshi')
})

test('overlays: Esc closes only the top layer, focus returns, scroll lock is restored', async ({ page }) => {
  await fresh(page, '/risk')
  await page.getByRole('button', { name: /^Bitcoin above \$150k, Dec 31, 1 contract/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Bitcoin above $150k, Dec 31' })
  const opener = drawer.getByRole('button', { name: 'Data sources…' })
  await opener.click()
  const modal = page.getByRole('dialog', { name: 'Data sources' })
  await expect(modal).toBeVisible()
  expect(await page.evaluate(() => document.querySelector('.layer-drawer')?.hasAttribute('inert'))).toBe(true)
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('.layer-modal'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(drawer).toBeVisible()
  await expect(opener).toBeFocused()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('')
})

test('overlays: nested detail panels keep focus inside the drawer and Back returns', async ({ page }) => {
  await fresh(page, '/risk')
  await page.getByRole('button', { name: /^Dec 2026 FOMC decision, 2 contracts/ }).click()
  const drawer = page.getByRole('dialog', { name: 'Dec 2026 FOMC decision' })
  await drawer.getByRole('button', { name: `${POS_BY_ID.fedk.market}: open details` }).press('Enter')
  const pos = page.getByRole('dialog', { name: POS_BY_ID.fedk.market })
  await expect(pos).toBeVisible()
  expect(await page.evaluate(() => !!document.activeElement?.closest('.layer-drawer'))).toBe(true)
  await pos.getByRole('button', { name: /Back/ }).click()
  await expect(drawer).toBeVisible()
  expect(await page.evaluate(() => !!document.activeElement?.closest('.layer-drawer'))).toBe(true)
})

test('allocation: switching grouping keeps the Holdings filter visible and reversible', async ({ page }) => {
  await fresh(page, '/overview')
  const seg = allocation('all', 'category').segments[0]
  await page.locator('#allocation .al-btn', { hasText: seg.key }).click()
  await page.locator('#allocation').getByRole('radio', { name: 'Platform' }).click()
  await expect(page.locator('#allocation')).toContainText(`Holdings are filtered by category: ${seg.key}`)
  await expect(page.locator('#holdings .filter-bar')).toContainText(seg.key)
  await page.locator('#allocation').getByRole('button', { name: 'Show by category' }).click()
  await expect(page.locator('#allocation .al-btn', { hasText: seg.key })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#allocation').getByRole('button', { name: /Show (all \d+ )?in Holdings/ }).click()
  await expect(page.locator('#holdings')).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Sections on this page' }).getByRole('link', { name: 'Holdings' })).toHaveAttribute('aria-current', 'location')
})

test('stored state: invalid data falls back safely; clearing removes only Scevia data after confirmation', async ({ page }) => {
  await page.goto('/scenario-lab')
  await page.evaluate(() => {
    sessionStorage.clear()
    sessionStorage.setItem('scevia-scenarios-v3', JSON.stringify([{ key: 'x', name: 'Restored', adjs: [{ id: 'ghost', to: 1, price: 0.5 }, { id: 'rec', to: 100, price: 0.5 }], saved: null, savedAt: null, color: '' }, { bad: true }]))
    sessionStorage.setItem('scevia-active-v3', JSON.stringify('missing'))
    sessionStorage.setItem('other-app', 'keep me')
  })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What do you want to explore?') // unknown active → entry page
  await expect(page.locator('#saved')).toContainText('Restored') // older scenario migrated, not discarded
  await page.getByRole('option', { name: /Restored/ }).click()
  await expect(rows(page)).toHaveCount(1) // dangling "ghost" reference dropped
  await page.getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'Data & privacy' }).click()
  const dlg = page.getByRole('dialog', { name: 'Data & privacy' })
  await dlg.getByRole('button', { name: /Clear saved scenarios/ }).click()
  await expect(dlg).toContainText('It can’t be undone')
  await dlg.getByRole('button', { name: 'Clear and reload' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('other-app'))).toBe('keep me')
  await expect(page.getByRole('option', { name: /Restored/ })).toHaveCount(0)
})

test('duplicate then reset returns to the duplicated adjustments, not an empty scenario', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Trim crypto, add to Fed')
  await page.getByRole('button', { name: 'Duplicate' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('(copy)')
  await target(page, POS_BY_ID.btc.market).fill('0')
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(rows(page)).toHaveCount(3)
  await expect(target(page, POS_BY_ID.btc.market)).toHaveValue('4000')
})

test('Scenario Lab entry: neutral, two clear starting paths, no empty charts, nothing created until chosen', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What do you want to explore?')
  await expect(page.getByRole('listbox', { name: 'Scenarios' }).getByRole('option')).toHaveCount(1)
  await expect(page.locator('#saved')).toContainText('No scenarios yet')
  await expect(page.locator('main svg[role="img"], main .stack-bars, #a-summary')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Modify your current portfolio' })).toContainText(fmt(account('all').cash))
  await expect(page.getByRole('region', { name: 'Modify your current portfolio' })).toContainText(`${positionsFor('all').length}`)
  expect(['[]', null]).toContain(await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v4')))
  await expect(page.locator('.home-ex').getByRole('button')).toHaveCount(3) // examples stay optional
  await startCurrent(page)
  const rail = page.getByRole('complementary', { name: 'Sections on this page' })
  await expect(rail.getByRole('link').first()).toHaveText('Setup')
  const order = await page.evaluate(() => ['setup', 'positions'].map((id) => document.getElementById(id)!.getBoundingClientRect().top))
  expect(order[0]).toBeLessThan(order[1])
  await expect(page.getByRole('tablist', { name: 'Scenario views' }).getByRole('tab')).toHaveCount(3)
})

test('scratch portfolio: starting capital, several searched markets, results, removal; actual portfolio untouched', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByLabel('Starting capital on Polymarket').fill('5000')
  const dlg = await startScratch(page, false)
  await expect(dlg.getByRole('tab', { name: 'Search markets' })).toHaveAttribute('aria-selected', 'true')
  await dlg.getByLabel('Search markets').fill('Ethereum')
  await expect(dlg).toContainText('Sample market data')
  await dlg.getByRole('button', { name: /Select Ethereum above \$5,000 on Dec 31 YES/ }).click()
  await dlg.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(rows(page)).toHaveCount(1)
  await expect(page.locator('.brow', { hasText: 'Ethereum' })).toContainText('Enter a target') // nothing filled in silently
  await target(page, 'Ethereum above $5,000 on Dec 31').fill('10000')
  await page.getByRole('button', { name: /Use reference 0.18/ }).click()
  // Polymarket Crypto taker fee: 0.01 × 10,000 × 0.18 × 0.82 = $14.76 (published formula, sample rate)
  await expect(summary(page, 'Cash after trades')).toHaveText('$3,185.24')
  await expect(summary(page, 'Value at reference marks')).toHaveText('$4,985') // capital isn't profit; at the reference price only the fee changes value
  await expect(page.locator('.brow', { hasText: 'Ethereum' })).toContainText('$14.76')
  await expect(summary(page, 'incl. added capital')).toHaveText('$5,000')
  await view(page, 'Analyze')
  await expect(page.locator('#a-alloc')).toContainText('Crypto')
  await expect(page.locator('#a-alloc')).toContainText('New')
  await expect(page.locator('#a-bridge')).toContainText('Added capital')
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await view(page, 'Compare')
  await expect(page.locator('#c-table')).toContainText('Empty portfolio')
  await expect(page.locator('#c-table')).toContainText('Polymarket $5,000')
  await view(page, 'Build')
  await page.getByRole('button', { name: /Remove Ethereum above/ }).click()
  await expect(rows(page)).toHaveCount(0)
  await page.goto('/overview')
  const a = account('all'), [i] = a.totalValue.toFixed(2).split('.')
  await expect(page.locator('.hero-fig')).toContainText(`$${Number(i).toLocaleString('en-US')}`)
})

test('paste link: only supported links resolve, against sample data, and the user picks the market', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startCurrent(page)
  const dlg = await openAdd(page)
  await dlg.getByRole('tab', { name: 'Paste link' }).click()
  const box = dlg.getByLabel('Market link'), find = dlg.getByRole('button', { name: 'Find market' })
  await expect(find).toBeDisabled()
  for (const [url, text] of [
    ['not a link', 'doesn’t look like a link'],
    ['https://example.com/event/x', 'aren’t supported'],
    ['https://polymarket.com/event/some-real-market', 'Live link lookup isn’t connected'],
    ['https://kalshi.com/markets/kxdelisted-26', 'market data is unavailable'],
  ] as const) {
    await box.fill(url); await find.click()
    await expect(dlg).toContainText(text)
    await expect(dlg.locator('.outcome-btn')).toHaveCount(0)
  }
  await box.fill('https://kalshi.com/markets/kxfeddecision-27jan'); await find.click()
  await expect(dlg).toContainText('This link covers 2 markets')
  await dlg.getByRole('button', { name: /Select Fed holds rates at Jan 2027 FOMC NO/ }).click()
  await dlg.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(page.locator('.brow', { hasText: 'Fed holds rates at Jan 2027 FOMC' })).toContainText('New')
})

test('existing holdings, duplicates and opposing positions in the builder', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startCurrent(page)
  await addHeld(page, 'btc')
  await expect(target(page, POS_BY_ID.btc.market)).toHaveValue(String(POS_BY_ID.btc.shares)) // starts at the current holding: no trade
  await expect(page.locator('.brow', { hasText: POS_BY_ID.btc.market }).getByText('No change')).toBeVisible()
  const dlg = await openAdd(page)
  await expect(dlg.getByLabel(`Select ${POS_BY_ID.btc.market} YES`)).toBeDisabled() // already in scenario
  await dlg.getByRole('tab', { name: 'Search markets' }).click()
  await dlg.getByLabel('Search markets').fill('Bitcoin')
  await expect(dlg.getByRole('button', { name: /Bitcoin above \$150k on Dec 31 YES/ })).toBeDisabled() // the same contract, reached by search
  await dlg.getByRole('button', { name: /Select Bitcoin above \$150k on Dec 31 NO/ }).click()
  await dlg.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(rows(page)).toHaveCount(2)
  await page.getByLabel('Target shares of Bitcoin above $150k on Dec 31').last().fill(String(POS_BY_ID.btc.shares))
  await page.getByLabel('Assumed price for Bitcoin above $150k on Dec 31').last().fill('0.72')
  await view(page, 'Analyze')
  await expect(page.locator('#payoff')).toContainText('if YES') // both sides held: labelled by outcome, not for/against
  await expect(page.locator('#a-exposure')).toContainText('Both sides')
})

test('constraints and fee settings are per scenario; a scratch scenario shows no unrelated event settings', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startScratch(page)
  await page.getByRole('button', { name: 'Edit assumptions' }).click()
  const drawer = page.getByRole('dialog', { name: 'Scenario assumptions' })
  await expect(drawer).not.toContainText('BTC')
  await expect(drawer).toContainText('Needs at least two events')
  await drawer.getByRole('radiogroup', { name: 'Trading fees' }).getByRole('radio', { name: 'Excluded' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.assume-bar')).toContainText('excluded')
  await page.getByRole('button', { name: 'New scenario' }).click()
  await page.getByRole('menuitem', { name: /Current portfolio/ }).click()
  await page.keyboard.press('Enter')
  await expect(page.locator('.assume-bar')).toContainText('provider estimate · taker')
  await view(page, 'Compare')
  await expect(page.locator('#c-table')).toContainText('Excluded')
  await expect(page.locator('#c-table')).toContainText('Provider estimate · taker')
})

test('unavailable values stay unavailable: beyond the event limit and without a reference price', async ({ page }) => {
  await page.goto('/scenario-lab')
  await page.evaluate(() => sessionStorage.clear())
  const markets = ['pm-eth-5k', 'ks-fedjan-cut', 'ks-fedjan-hold', 'pm-gdp-q4', 'ks-nyc-jan-warm', 'pm-lakers-2027', 'pm-sol-500', 'ks-unemp-45']
  await page.evaluate((ids) => {
    const inst = (m: string, refPrice: number | null) => ({ provider: m.startsWith('pm') ? 'pm' : 'ks', eventId: m, eventTitle: m, marketId: m, marketTitle: m, outcome: 'YES', category: 'Economics', resolves: '2027-01-31', refPrice, refAsOf: refPrice == null ? null : '2026-11-24', source: 'sample' })
    const adjs = ids.map((m) => ({ id: `x:${m}:YES`, to: 10, price: 0.3, instrument: inst(m, 0.3) }))
    adjs.push({ id: 'x:ks-wti-90:YES', to: 10, price: 0.4, instrument: inst('ks-wti-90', null) })
    sessionStorage.setItem('scevia-scenarios-v4', JSON.stringify([{ key: 'big', name: 'Many events', baseline: 'portfolio', funding: {}, assumptions: {}, adjs, saved: null, savedAt: null, color: '' }]))
    sessionStorage.setItem('scevia-active-v4', JSON.stringify('big'))
  }, markets)
  await page.reload()
  await expect(summary(page, 'Settlement range')).toHaveText('Unavailable')
  await expect(summary(page, 'Value at reference marks')).toHaveText('Unavailable')
  await view(page, 'Analyze')
  await expect(page.locator('#a-summary')).toContainText('above 16 events')
  await expect(page.locator('#a-bridge')).toContainText('Unavailable')
  await expect(page.locator('#a-alloc')).toContainText('Allocation is unavailable')
  await view(page, 'Compare')
  await expect(page.locator('#c-table')).toContainText('change unavailable')
  await expect(page.locator('main')).not.toContainText('NaN')
})

for (const vp of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
  test(`wide desktop ${vp.width}px: the workspace uses the width and keeps text readable`, async ({ page }) => {
    await page.setViewportSize(vp)
    for (const path of ['/overview', '/scenario-lab']) {
      await page.goto(path)
      await expect(page.locator('main h1')).toBeVisible()
      const r = await page.evaluate(() => ({ main: document.querySelector('main')!.getBoundingClientRect().width, vw: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))
      expect(r.overflow).toBeLessThanOrEqual(1)
      expect(r.main / r.vw).toBeGreaterThan(0.78)
    }
    await page.goto('/overview')
    expect(await page.locator('.summary').first().evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(761)
  })
}

test('hand-off into an empty-portfolio scenario adds from zero unless quantities are copied explicitly', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startScratch(page)
  await page.goto(`/scenario-lab?add=shut&from=Test&req=t1`)
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await expect(add).toContainText('starts from an empty portfolio')
  await expect(add).toContainText('Added from zero; you enter the quantity')
  await add.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(target(page, POS_BY_ID.shut.market)).toHaveValue('')
  await expect(page.getByRole('status')).toContainText('from zero')
  await page.goto(`/scenario-lab?add=btc&from=Test&req=t2`)
  await add.getByText('Copy my current quantities as purchases').click()
  await expect(add).toContainText(`Buys ${POS_BY_ID.btc.shares.toLocaleString('en-US')} shares`)
  await add.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(page.locator('.brow', { hasText: POS_BY_ID.btc.market })).toContainText(`Buy ${POS_BY_ID.btc.shares.toLocaleString('en-US')}`)
})

test('switching the starting portfolio asks what to do with held positions', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Exit sports longshots')
  await page.getByRole('radiogroup', { name: 'Starting portfolio' }).getByRole('radio', { name: 'Empty portfolio' }).click()
  const dlg = page.getByRole('dialog', { name: 'Start from an empty portfolio?' })
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('radiogroup', { name: 'Starting portfolio' }).getByRole('radio', { name: 'Current portfolio' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radiogroup', { name: 'Starting portfolio' }).getByRole('radio', { name: 'Empty portfolio' }).click()
  await dlg.getByRole('button', { name: 'Clear quantities of held positions' }).click()
  await expect(target(page, POS_BY_ID.cel.market)).toHaveValue('')
  await expect(summary(page, 'Cash after trades')).toHaveText('$0.00')
})

test('a partly typed or malformed price is never replaced by the previous value', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Hedge the shutdown')
  const cash = summary(page, 'Cash after trades')
  const withTrade = await cash.innerText()
  const price = page.getByLabel(`Assumed price for ${POS_BY_ID.shut.market}`)
  await price.fill('0.')
  await expect(page.locator('.brow', { hasText: POS_BY_ID.shut.market })).toContainText('Finish entering a price')
  await expect(cash).not.toHaveText(withTrade) // the trade is out of the results while the price is incomplete
  await expect(page.getByRole('button', { name: /Save scenario|Saved/ })).toBeDisabled()
  await price.fill('4.5e-1')
  await expect(page.getByRole('alert').first()).toContainText('Enter a price such as 0.45')
  await price.fill('0.47')
  await expect(cash).toHaveText(withTrade)
})

test('reducing the worst single-event loss is shown as an improvement', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startCurrent(page)
  await addHeld(page, 'hot')
  await target(page, POS_BY_ID.hot.market).fill('2000')
  await view(page, 'Compare')
  const row = page.locator('#c-table tr', { hasText: 'Worst single-event outcome' })
  await expect(row.locator('td.is-active small')).toHaveClass(/gain/)
  await expect(row.locator('td.is-active')).toContainText('−$')
})

test('negative cash is a funding need, not a cash share; unavailable fees are labelled until a fee is chosen', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  const dlg = await startScratch(page, false)
  await dlg.getByLabel('Search markets').fill('unemployment')
  await dlg.getByRole('button', { name: /Select US unemployment above 4.5% in January YES/ }).click()
  await dlg.getByRole('button', { name: 'Add 1 position' }).click()
  await target(page, 'US unemployment above 4.5% in January').fill('1000')
  await page.getByRole('button', { name: /Use reference/ }).click()
  await expect(page.locator('#build-summary')).toContainText('Needs $220.00 more on Kalshi')
  await expect(page.locator('.brow', { hasText: 'US unemployment' })).toContainText('Unavailable')
  await expect(page.locator('#build-summary')).toContainText('+ 1 unavailable')
  await view(page, 'Analyze')
  await page.getByRole('radiogroup', { name: 'Allocation basis' }).getByRole('radio', { name: 'Incl. cash' }).click()
  await expect(page.locator('#a-alloc')).toContainText('Cash-inclusive allocation is unavailable')
  await view(page, 'Compare')
  await expect(page.locator('#c-deploy')).toContainText('needs $220 funding')
  await page.getByRole('button', { name: 'Edit assumptions' }).click()
  const drawer = page.getByRole('dialog', { name: 'Scenario assumptions' })
  await drawer.getByRole('radiogroup', { name: 'Trading fees' }).getByRole('radio', { name: 'Custom' }).click()
  await drawer.getByLabel('Custom fee, % of notional').fill('1')
  await page.keyboard.press('Escape')
  await view(page, 'Build')
  await expect(page.locator('.brow', { hasText: 'US unemployment' })).toContainText('$2.20')
})

test('multi-select add: several holdings and markets at once, outcome by outcome, without duplicates', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startCurrent(page)
  const dlg = await openAdd(page)
  await dlg.getByLabel(`Select ${POS_BY_ID.btc.market} YES`).check()
  await dlg.getByLabel(`Select ${POS_BY_ID.cel.market} YES`).check()
  await dlg.getByRole('tab', { name: 'Search markets' }).click()
  await dlg.getByLabel('Search markets').fill('Fed')
  await expect(dlg).toContainText('2 markets · pick each one you want') // a multi-market event lists each market
  await dlg.getByRole('button', { name: /Select Fed cuts rates at Jan 2027 FOMC YES/ }).click()
  await dlg.getByLabel('Search markets').fill('Bitcoin')
  await expect(dlg.getByRole('button', { name: /^Deselect Bitcoin above \$150k on Dec 31 YES/ })).toHaveAttribute('aria-pressed', 'true') // same instrument as the picked holding
  await expect(dlg.locator('.basket-chip')).toHaveCount(3)
  await dlg.getByRole('button', { name: `Remove ${POS_BY_ID.cel.market} YES from selection` }).click()
  await dlg.getByRole('button', { name: 'Add 2 positions' }).click()
  await expect(rows(page)).toHaveCount(2)
  const again = await openAdd(page)
  await expect(again.getByLabel(`Select ${POS_BY_ID.btc.market} YES`)).toBeDisabled()
  await expect(again.getByLabel(`Select ${POS_BY_ID.cel.market} YES`)).toBeEnabled()
})

test('sizing by amount or % of start describes the same position; switching the view never changes it', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByLabel('Starting capital on Polymarket').fill('10000')
  const dlg = await startScratch(page, false)
  await dlg.getByLabel('Search markets').fill('Ethereum')
  await dlg.getByRole('button', { name: /Select Ethereum above \$5,000 on Dec 31 YES/ }).click()
  await dlg.getByRole('button', { name: 'Add 1 position' }).click()
  await page.getByRole('radiogroup', { name: 'Size positions by' }).getByRole('radio', { name: '$ Amount' }).click()
  await page.getByLabel('Target amount for Ethereum above $5,000 on Dec 31').fill('1000')
  await page.getByLabel('Assumed price for Ethereum above $5,000 on Dec 31').fill('0.2')
  const row = page.locator('.brow', { hasText: 'Ethereum' })
  await expect(row).toContainText('= 5,000 shares')
  const cash = await summary(page, 'Cash after trades').innerText()
  await page.getByRole('radiogroup', { name: 'Size positions by' }).getByRole('radio', { name: '% of start' }).click()
  await expect(page.getByLabel('Target % of starting value for Ethereum above $5,000 on Dec 31')).toHaveValue('10') // $1,000 of a $10,000 start
  await page.getByRole('radiogroup', { name: 'Size positions by' }).getByRole('radio', { name: 'Shares' }).click()
  await expect(target(page, 'Ethereum above $5,000 on Dec 31')).toHaveValue('5000')
  await expect(summary(page, 'Cash after trades')).toHaveText(cash) // only the view changed
  await target(page, 'Ethereum above $5,000 on Dec 31').fill('12.5') // fractional quantities are allowed
  await expect(row).toContainText('Buy 12.5')
})

test('bulk actions: removing an adjustment restores the holding; setting the target to 0 simulates an exit; undo', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Trim crypto, add to Fed')
  const startCash = await summary(page, 'Starting cash').innerText()
  await page.getByLabel(`Select ${POS_BY_ID.btc.market}`).check()
  await page.getByLabel(`Select ${POS_BY_ID.fedk.market}`).check()
  const bar = page.getByRole('toolbar', { name: 'Selected positions' })
  await expect(bar).toContainText('2 selected')
  await expect(bar).toContainText('Remove restores your current holding')
  await bar.getByRole('button', { name: 'Set target to 0' }).click()
  await expect(target(page, POS_BY_ID.btc.market)).toHaveValue('0')
  await expect(page.locator('.brow', { hasText: POS_BY_ID.btc.market })).toContainText('Exit')
  await page.getByRole('status').filter({ hasText: 'Set 2 targets to 0' }).getByRole('button', { name: 'Undo' }).click()
  await expect(target(page, POS_BY_ID.btc.market)).toHaveValue('4000')
  await page.getByRole('checkbox', { name: 'Select all positions' }).check()
  await bar.getByRole('button', { name: 'Remove from scenario' }).click()
  await expect(rows(page)).toHaveCount(0)
  await expect(summary(page, 'Cash after trades')).toHaveText(startCash) // back to the current portfolio: no trades
})

test('analysis leads back to the position that causes it', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await startExample(page, 'Trim crypto, add to Fed')
  await view(page, 'Analyze')
  await expect(page.locator('#a-bridge')).toContainText('Price vs. mark')
  await expect(page.locator('#a-range')).toContainText('Scenario')
  await page.locator('#a-alloc').getByRole('button', { name: 'Crypto', exact: true }).click()
  await expect(page.locator('#a-positions .filter-bar')).toContainText('Crypto')
  await page.locator('#a-positions tr', { hasText: POS_BY_ID.btc.market }).getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('tab', { name: /^Build/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel(`Target shares of ${POS_BY_ID.btc.market}`)).toBeFocused()
})

test('compare: pick scenarios; different funding venues are flagged even with equal totals', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByLabel('Starting capital on Polymarket').fill('5000')
  await startScratch(page)
  await page.getByRole('option', { name: /All scenarios/ }).click()
  await page.getByLabel('Starting capital on Kalshi').fill('5000')
  await startScratch(page)
  await view(page, 'Compare')
  await expect(page.locator('#c-pick')).toContainText('different portfolios, capital, funding venues or assumptions')
  await expect(page.locator('#c-table')).toContainText('Polymarket $5,000')
  await expect(page.locator('#c-table')).toContainText('Kalshi $5,000')
  const cols = page.locator('#c-table thead th')
  await expect(cols).toHaveCount(4) // metric + actual + 2 scenarios
  await page.getByRole('checkbox', { name: 'Current portfolio actual' }).uncheck()
  await expect(cols).toHaveCount(3)
  await page.getByRole('radiogroup', { name: 'Comparison basis' }).getByRole('radio', { name: 'Change from start' }).click()
  await expect(page.locator('#c-range')).toContainText('minus each scenario’s own starting value')
})

test('accounts & records: filter, select across pages, preview and confirm a bulk exclusion, undo; portfolio figures unchanged', async ({ page }) => {
  await fresh(page, '/accounts')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accounts & records')
  await expect(page.locator('#accounts')).toContainText('Polymarket · Wallet A')
  await expect(page.locator('#accounts')).toContainText('Polymarket · Wallet B') // two accounts on one venue
  await expect(page.locator('#accounts')).toContainText('Opening balance unknown')
  await page.getByLabel('Select all records on this page').check()
  const scope = page.getByRole('toolbar', { name: 'Selected records' })
  await expect(scope).toContainText('10 selected')
  await scope.getByRole('button', { name: /Select all 21 matching/ }).click()
  await expect(scope).toContainText('21 selected')
  await scope.getByRole('button', { name: 'Clear selection' }).click()
  await page.getByRole('search', { name: 'Filter records' }).getByLabel('Account').selectOption({ label: 'Polymarket · Wallet B' })
  await page.getByLabel('Select all records on this page').check()
  await page.getByRole('toolbar', { name: 'Selected records' }).getByRole('button', { name: 'Exclude…' }).click()
  const confirm = page.getByRole('dialog', { name: /Exclude 4 selected records/ })
  await expect(confirm).toContainText('source data isn’t deleted')
  await expect(confirm).toContainText('With unknown amounts') // fees not reported are counted, not zero
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.rec-table tr.excluded')).toHaveCount(0)
  await page.getByRole('toolbar', { name: 'Selected records' }).getByRole('button', { name: 'Exclude…' }).click()
  await page.getByRole('dialog', { name: /Exclude 4 selected records/ }).getByRole('button', { name: 'Exclude 4' }).click()
  await expect(page.locator('.rec-table tr.excluded')).toHaveCount(4)
  await page.getByRole('button', { name: /Undo: Exclude 4 records/ }).click()
  await expect(page.locator('.rec-table tr.excluded')).toHaveCount(0)
  await page.goto('/overview')
  const a = account('all'), [i] = a.totalValue.toFixed(2).split('.')
  await expect(page.locator('.hero-fig')).toContainText(`$${Number(i).toLocaleString('en-US')}`)
})

test('accounts & records: a supplemental import keeps overlaps for review; duplicates resolve explicitly', async ({ page }) => {
  await fresh(page, '/accounts')
  await page.getByRole('button', { name: 'Import CSV…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import a CSV file' })
  await expect(dlg).toContainText('nothing is read from your computer or uploaded')
  await dlg.getByRole('button', { name: 'Continue' }).click()
  await expect(dlg.getByRole('radiogroup', { name: 'Import relationship' }).getByRole('radio', { name: 'Supplements its history' })).toHaveAttribute('aria-checked', 'true')
  await dlg.getByRole('button', { name: 'Continue' }).click()
  await expect(dlg).toContainText('Matches a-001')
  await dlg.getByRole('button', { name: 'Continue' }).click()
  await dlg.getByRole('button', { name: 'Import 5 rows' }).click()
  await expect(dlg).toContainText('Waiting for review')
  await dlg.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: '2 need review' }).click()
  await expect(page.locator('.rec-table tbody tr')).toHaveCount(2)
  await page.locator('.rec-table tbody tr').filter({ hasText: 'Bitcoin' }).getByRole('button', { name: /Bitcoin/ }).click()
  const drawer = page.getByRole('dialog', { name: /Buy · Bitcoin/ })
  await drawer.getByRole('button', { name: /Duplicate of a-002/ }).click()
  await expect(drawer).toContainText('duplicate of a-002')
  await drawer.getByRole('button', { name: 'Restore as delivered' }).click()
  await expect(drawer).toContainText('Needs review')
})
