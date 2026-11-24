# Component inventory

Load this file when building or changing UI. **Reuse before creating.** Adding a component means adding an entry here in the same change.
Reference implementation (concept stage): `design-concepts/v2/assets/components.css`. Class names below are the concept classes.

Required states for every interactive component: **default, hover, focus-visible (2px `focus-ring`), active, disabled**. Data components also need **loading (skeleton), empty, error, partial-data**.

## Shell
- **AppShell** `.shell`: top bar + left section rail + main. Use for every product page. Don't use for modals or onboarding.
- **TopNav** `.topbar`: brand wordmark (`/brand/scevia-logo.png`, 28px tall), the 4 areas (Overview, Analytics, Risk, Scenario Lab), utilities on the right (search ⌘K, sync status, data-mode chip, help, alerts, settings, avatar). Don't add more top-level areas. New things become sections.
- **SectionRail** `.rail`: this page's sections as jump links, with the active one tracked on scroll and optional counts or flags. Also saved views/scenarios and one context card. Don't nest more than one level deep.

## Layout and text
- **PageHeader** `.page-head`: caption (scope + period), H1 answering the page's question, actions on the right (max one primary). Don't put KPIs in it.
- **Card** `.card` + `.card-h` + `.card-b`: the only container. Use for any chart, table, or grouped content. Don't nest cards. Use `.divider` inside.
- **NarrativeSummary** `.summary`: 2–3 sentences explaining the numbers, with inline links. Use at the top of Overview and Analytics, and below any complex chart. Don't use it for marketing copy or advice. Partial data → must mention coverage.

## Figures
- **HeroFigure** `.hero-fig`: large value with smaller decimals and a currency, then a DeltaBadge. One per page. Loading → skeleton block of the same size.
- **DeltaBadge** `.delta.gain|loss|flat`: signed money or percent change. Always shows a sign. Don't use it for non-monetary values.
- **MetricTile** `.tile` inside `.tiles`: label + ⓘ, value, footnote. Use 3–6 in a row (Delta / PV "Highlights"). Don't use it for a single number already shown as a HeroFigure.
- **InfoTip** `.itip`: "How calculated" trigger. Required on every derived metric.

## Controls
- **Button** `.btn` `.btn-primary` (white) · `.btn-secondary` · `.btn-ghost` · `.btn-accent` (Scenario actions only). One primary per view. Disabled = 40% opacity and not focusable. Loading = spinner in place of the icon, width kept.
- **IconButton** `.icon-btn`: needs `aria-label`. Hit area ≥ 34px.
- **Segmented** `.seg`: 2–5 mutually exclusive views (period, grouping). Don't use it for navigation between pages.
- **Pills** `.pills`: filter chips (All / Polymarket / Kalshi; categories). Multi-select is allowed. Don't use pills for actions.
- **Tabs** `.tabs`: sub-views inside a card (getquin pattern). Don't use tabs to switch pages.
- **Slider** `.slider`: scenario position sizing. Must show current value, a "current" marker, and min/max. Keyboard: arrows ±100, PageUp/Down ±1,000.
- **Field** `.field`: labelled input. Label always visible. Error text sits below the field in `loss-fg`.

## Data display
- **Chip** `.chip` (+ `.yes .no .warn .info .accent`): status, side, or relationship labels. Text is required. Don't make chips clickable unless they're filters.
- **PlatformBadge** `.plat.pm|.ks`: Polymarket/Kalshi marker with a letter and a title tooltip.
- **DataTable** `table.dt`: dense rows, sticky header, right-aligned numbers, row hover reveals a row action (e.g. Simulate). Empty → EmptyState in the table body. Partial → a footnote row.
- **PayoffBar** `.payoff`: if-for / if-against two-sided bar for one position or event. Always labelled with the signed amount.
- **ChartFrame** `.chart`: SVG chart with axis labels, direct labels or a legend, and a tooltip. Must have a text alternative (table toggle or summary).
- **Callout** `.callout.info|warn`: a caveat or explanation with an icon. Don't stack more than 2 per card.
- **CoverageMeter** `.coverage`: share of reconciled data per source, with freshness. Required wherever net P&L is shown as exact.
- **InsightCard** `.insight`: pattern headline + plain explanation + sample size + one link. Must show `n =`. Don't use it when n < 5.

## Interactive layer (`web/src/components/`, styles in `web/src/styles/app.css`)
- **Menu** `Menu` (`.menu`): dropdown anchored to a trigger. Trigger gets `aria-expanded`; items must be `role="menuitem"`; arrow keys move, Esc closes and refocuses the trigger. Use for help, notifications, settings, account, "Add position". Don't use for page navigation.
- **Modal** `Modal`: a focused decision with Cancel + one primary action (guardrail, classify relationship, delete scenario). Traps Tab, focuses the first field (or `data-autofocus`), returns focus on close. Don't use for long lists (use Drawer).
- **Drawer** `Drawer`: right-side detail list (fills, trades behind an insight, fee estimates). Same focus rules as Modal; Esc and scrim click close it.
- **CommandPalette** (⌘K): jump to areas, positions (open in Scenario Lab) and events (open in Risk). Arrow keys + Enter.
- **Tabs** `Tabs`: real buttons with `role="tab"`; ←/→ move between tabs.
- **Switch** `.switch` (role=switch): a binary assumption (fees on/off). Don't use for view changes (use Segmented).
- **Select** `.select`: native select for long option lists (outcome-matrix events).
- **InfoTip**: "How calculated" popover on hover and focus; Esc closes. Text must match the definitions in `web/src/lib/finance.ts`.
- **InfoModal** (Help menu): the shared definitions list and the prototype's data & privacy statement. Keep both literally true for the current build.
- **PositionDrawer** `PositionDrawer`: position drill-down showing cost/value/unrealized, payoff if for/against, the fills behind the average cost, source freshness, and actions (Simulate, See event risk). Opens from any position row (click or Enter).
- **ConnectSources** `useConnect()`: the data-source flow, run as a labelled **demo**. Never request a real wallet address or file, never claim a connection, sync or verification happened.
- **DemoTag** `.demo-tag`: marks anything simulated (connect flow, sample coverage results).
- **Staleness** `.stale`: warn-coloured source age when data is older than 24h. Pair it with an explanation of what “stale” means for the numbers.
- **AdjustmentRow** (Scenario Lab): slider + target-shares field + hypothetical-price field with inline validation (`role="alert"`), and a plain-language line saying what the trade does to cash. Invalid rows are excluded from results and block Save.

## Feedback
- **EmptyState** `.empty`: one sentence + one action (e.g. "Clear filters").
- **Unavailable** `.unavailable`: say plainly when a metric can't be computed (too few trades, no prior period) instead of showing a guess.
- **Skeleton** `.skeleton`: matches final layout dimensions. Show it if loading takes > 300 ms.
- **Toast** `.toast`: confirmations ("Scenario saved"). Auto-dismisses after 4 s. Never used for errors that need action.

## Scenario Lab specific
- **AdjustmentRow** `.adj`: position + action chip (Buy / Sell / Exit / No change) + Slider + hypothetical price Field + cash impact.
- **BeforeAfterTable** `.ba`: metric · current · scenario · change (DeltaBadge, colour by "better for the user", not by sign).
- **OutcomeMatrix** `.matrix`: 2×2 (or 2×N) joint outcomes, each tile shows scenario P&L, "was" P&L, and the change. Unknown dependencies → `warn` chip on the card.
