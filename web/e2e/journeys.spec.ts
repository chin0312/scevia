import { expect, test, type Page } from '@playwright/test'
import { POS_BY_ID, account, allocation, exposures, periodRange, periodStats, positionsFor } from '../src/lib/finance'
import { fmt, sfmt } from '../src/lib/format'

const fresh = async (page: Page, path: string) => {
  await page.goto(path)
  await page.evaluate(() => sessionStorage.clear())
  await page.goto(path)
}

test('1 · view a position in Overview, then add it to a scenario only after choosing where', async ({ page }) => {
  await fresh(page, '/overview')
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
  await add.getByLabel('Target scenario').selectOption({ label: 'Exit sports longshots · 2 changes' })
  await add.getByRole('button', { name: 'Add 1 position' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Exit sports longshots')
  // starts at the current holding and mark: nothing changes until the user edits it
  await expect(page.getByRole('slider', { name: `Target shares of ${p.market}` })).toHaveValue(String(p.shares))
  await expect(page.locator('.adj', { hasText: p.market }).getByText('No change')).toBeVisible()
  await expect(page.getByRole('status')).toContainText(p.market)
})

test('1b · cancelling an incoming add changes no scenario; already-included positions are skipped', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v3'))).not.toBeNull()
  const before = await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v3'))
  await page.goto('/scenario-lab?addEvent=fed')
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await expect(add.getByRole('checkbox')).toHaveCount(2) // both Fed contracts, across platforms
  await add.getByRole('button', { name: 'Cancel' }).click()
  await expect(add).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v3'))).toBe(before)

  await page.goto('/scenario-lab?add=fedk') // the draft already adjusts this contract
  await page.getByRole('dialog', { name: 'Add to a scenario' }).getByLabel('Target scenario').selectOption({ label: 'Trim crypto, add to Fed · 3 changes' })
  await expect(page.getByText('Already in this scenario: left as it is')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
})

test('2 · adjusting a scenario updates results; invalid input is caught', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  const cashRow = page.locator('#ba .ba-row', { hasText: /^Cash/ })
  const before = await cashRow.locator('.after').innerText()
  const shares = page.getByLabel('Target shares', { exact: true }).first()
  await shares.fill('0') // first adjustment: BTC → full exit
  await expect(cashRow.locator('.after')).not.toHaveText(before)
  await expect(page.getByText('Exit', { exact: true }).first()).toBeVisible()

  const price = page.getByLabel('Assumed fill price ($)').first()
  await price.fill('1.5')
  await expect(page.getByRole('alert').first()).toContainText('between $0.01 and $0.99')
  await expect(page.getByRole('button', { name: /Save scenario|Saved/ })).toBeDisabled()
  await price.fill('0.30')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save scenario' }).click()
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled()
})

test('2b · a purchase beyond available cash is explored as a funded hypothetical, with the gap shown', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByRole('button', { name: 'Add position' }).click()
  await page.getByRole('menuitem', { name: /2026 hottest year on record/ }).click()
  const hot = POS_BY_ID.hot, target = hot.shares + 5000
  expect((target - hot.shares) * hot.mark).toBeGreaterThan(account('ks').cash)
  await page.locator('#sh-hot').fill(String(target))
  await expect(page.getByText(/Needs \$[\d,.]+ more cash than you hold/)).toBeVisible()
  await expect(page.getByText('Kalshi purchases in this scenario exceed available cash; included as if funded.').first()).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0) // not an input error
  await expect(page.locator('#ba .ba-row', { hasText: /^Positions at mark/ }).locator('.after')).toContainText('$') // trade is in the results
  await expect(page.getByRole('button', { name: 'Save scenario' })).toBeEnabled()
})

test('2c · scenario create, rename, save and revert behave predictably', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.getByText('+ New scenario').click()
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
  const scenarios = await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v3'))
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
  expect(await page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v3'))).toBe(scenarios)
})

test('relationship edited in Scenario Lab is the same one Risk uses', async ({ page }) => {
  await fresh(page, '/scenario-lab')
  await page.locator('#assume').getByRole('button', { name: 'Change' }).click()
  const dialog = page.getByRole('dialog', { name: 'Classify relationship' })
  await dialog.getByText('Mutually exclusive outcomes').click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('#assume')).toContainText('Mutually exclusive')
  await page.getByRole('link', { name: 'Risk' }).click()
  await expect(page.locator('#rel')).toContainText('Mutually exclusive outcomes')
  await expect(page.locator('#payoffs .foot')).toContainText('combinations excluded')
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

const scenariosIn = (page: Page) => page.evaluate(() => sessionStorage.getItem('scevia-scenarios-v3'))
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
  await settle(page)
  const slider = page.getByRole('slider', { name: `Target shares of ${POS_BY_ID.fedk.market}` })
  await expect(slider).toHaveValue('6200')
  await page.goto('/overview')
  const row = page.getByRole('row', { name: `${POS_BY_ID.fedk.market}: open details` })
  await row.hover()
  await row.getByRole('button', { name: 'Simulate' }).click()
  const add = page.getByRole('dialog', { name: 'Add to a scenario' })
  await add.getByLabel('Target scenario').selectOption({ label: 'Trim crypto, add to Fed · 3 changes' })
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
  const change = drawer.getByRole('button', { name: 'Change' })
  await change.click()
  const modal = page.getByRole('dialog', { name: 'Classify relationship' })
  await expect(modal).toBeVisible()
  expect(await page.evaluate(() => document.querySelector('.layer-drawer')?.hasAttribute('inert'))).toBe(true)
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('.layer-modal'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(drawer).toBeVisible()
  await expect(change).toBeFocused()
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Current portfolio') // unknown active → current portfolio
  await page.getByRole('option', { name: /Restored/ }).click()
  await expect(page.getByRole('slider')).toHaveCount(1) // dangling "ghost" reference dropped
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
  await page.getByRole('button', { name: 'Duplicate' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('(copy)')
  const first = page.getByLabel('Target shares', { exact: true }).first()
  await first.fill('0')
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page.getByRole('slider')).toHaveCount(3)
  await expect(page.getByRole('slider').first()).toHaveValue('4000')
})
