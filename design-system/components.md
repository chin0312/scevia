# Component inventory

Load this file when building or changing UI. **Reuse before creating.** Adding a component means adding an entry here in the same change.
Reference implementation (concept stage): `design-concepts/v2/assets/components.css`. Class names below are the concept classes.

Required states for every interactive component: **default, hover, focus-visible (2px `focus-ring`), active, disabled**. Data components also need **loading (skeleton), empty, error, partial-data**.

## Shell
- **AppShell** `.shell`: top bar + left section rail + main. Use for every product page. Don't use for modals or onboarding.
- **TopNav** `.topbar`: brand wordmark (`/brand/scevia-logo.png`, 28px tall), the 4 areas (Overview, Analytics, Risk, Scenario Lab), then six utilities, one job each: **Search** (⌘K palette) · **Portfolio** (`PortfolioSelector` + `DataStatus`, see below) · **Help** menu (opens `HelpCentre` at a tab; feedback link) · **Notifications** (`NotificationCentre`) · **Settings** (gear → `SettingsModal`) · **Account** (`AccountMenu`). No item appears in two utilities. The top bar is `z-index: --z-dropdown` at every width; on phones the utilities wrap to their own row and menus are capped to the viewport (`Menu` width `min(width, 100vw − 16px)`, anchored to the top bar). Don't add top-level areas.
- **PortfolioSelector** (`components/Workspace.tsx`, `.ws-chips`, `.ws-opt`): the chip names the selected portfolio and its valuation date. Menu: *Portfolios* (`menuitemradio`: Sample portfolio · fictional, Demo portfolio · real markets, virtual capital), *My portfolios* (empty state; *Create portfolio* disabled with its reason), the selected portfolio's accounts with venue and native asset, and the five *Manage portfolio* links. Switching never changes a scenario, record or input.
- **DataStatus** (`components/Workspace.tsx`, `.ds-pill`, `.ds-list`): the pill shows the least current of market, account and valuation (`summaryState`, `lib/freshness.ts`), with a dot whose tone comes from the state. It reads *Streaming* only when all three stream; there is no single "Live" light. The menu lists every stream (market, account, valuation, history, sync, sources) with its state, detail and as-of time, *Last checked …*, *Refresh now* (stays open, reports "no new data") and *Data coverage*. States: streaming, recently refreshed, refreshing, delayed, stale, disconnected, partial, unavailable, import only, cached market snapshot, fixed sample.
- **WorkspaceGate** (`components/Workspace.tsx`, `.ws-state`): replaces the page while a portfolio is loading (skeleton), unavailable (Demo without approved market data: explanation, *Open Sample portfolio*, *Try again*) or failed. A refreshing portfolio stays on screen.
- **PeriodControl** (`components/PeriodControl.tsx`, `.period-ctl`, `.custom-range`): presets 1W · 1M · 3M · 6M · YTD · 1Y · All (a preset the history doesn't cover is disabled with a reason) + *Custom* with From/To dates, validated on *Apply* (`role="alert"`). Below 640px the presets become one select.
- **As-of line** `.asof`: valuation date and basis, market-data state, native amounts per venue and the indicative-total note (Overview hero), history coverage (Analytics), holdings date and relationship basis (Risk).
- **CommandPalette** (`shell.tsx`, `.palette`): combobox + listbox with `aria-activedescendant`; groups (Actions, Pages, Portfolio, Accounts, Positions, Events, Transactions, Scenarios, Help), 5 per group with *Show N more*, ranked (prefix > word > substring; all terms must match label, context or keywords). Results are keyed by stable ids and show context (account, outcome, reference). Empty query shows suggested actions and destinations.
- **NotificationCentre** (`components/Notifications.tsx`, `lib/notifications.ts`): All / Unread (`menuitemradio`), category select, items with category · date · sample/local, unread tint and a per-item *Mark as read*, *Mark all read*, *Notification preferences*. Opening one marks only that one. Read ids persist in `scevia-notif-read`. Empty states for no notifications, all read, and empty category.
- **HelpCentre** (`components/Help.tsx`, Modal + Tabs): Getting started (steps linking into the app), Guides (cards with a destination), Methodology (calculated now / with connected accounts), Shortcuts (platform-aware ⌘/Ctrl), About (feedback → GitHub Issues).
- **SettingsModal** (`components/Settings.tsx`, `lib/settings.tsx`, `.set-row`): tabs General · Analytics · Risk · Scenario Lab · Notifications. Every control takes effect immediately. Footer: *Reset all…* (inline confirmation; preferences only), *Restore {section} defaults*, *Done*. No privacy or data sources here.
- **AccountMenu / PrivacyDialog** (`components/Account.tsx`): guest header, *Data & privacy*, *Sign in* disabled with a reason. The dialog lists data groups (preferences, scenarios, sample records, notification state) with *Clear…* each and *Clear everything…*, each with an inline confirmation; clearing reloads so no view writes the data back.

## Responsive behaviour (`web/src/styles/responsive.css`)
Desktop-first and **fluid**:
- The shell grows with the viewport up to `--layout-content-max` (2560px, an ultrawide cap only).
- Running text keeps `--layout-text-max`.
- From 1680px, gutters and the rail grow; from 2200px, tiles get more room.
- Charts draw at their measured width, and line charts grow a little in height on wide screens.

Smaller screens reflow instead of shrinking.
- **≤1400px:** three-card rows weight the first card (1.3fr).
- **≤1100px:**
  - one column;
  - the SectionRail becomes a sticky horizontal section bar (children, context cards and counts hidden; Scenario Lab keeps its scenario switcher via `.rail-keep`; page-only extras use `.rail-extra`);
  - the search button becomes icon-only;
  - 3-card rows become 2 + full-width first card.
- **≤900px:** primary nav moves to its own row; the data chip drops the date.
- **≤640px:**
  - the top bar scrolls away;
  - tiles go two per row;
  - drawers go full width;
  - the profile menu is hidden (its items stay reachable from Settings).
- **Card internals use container queries** (`.card` is an inline-size container), so the same card adapts in a narrow column or full width:
  - allocation stacks;
  - concentration names wrap above their bars;
  - payoff rows restack;
  - comparison grids collapse.
- **Charts** draw at their measured width (`useWidth`), so axis text stays at its real size; dense axes thin their labels.
- **Figures** (`.tile .v`, `.hl-tile .v`, `.cell .v`, `.ministat .v`, `.hero-fig`) never wrap; they get smaller instead.
- **Touch:** charts use `touch-action: pan-y` so the page still scrolls over them.

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
- **Event relationships** (Risk `#rel`, event details, matrix chip): show class *and* provenance (verified / note / this scenario only). Copy says “settlement logic, not correlation”. No event-specific controls.
- **Inspectable rows** (`.conc-btn`, `.po-btn`, `.attr-btn`, `.bucket-btn`, `.tl-btn`, `.list-btn`, chart steps `.step`, calendar `.cal-dot`): rows and chart marks that open a detail panel are real buttons (or `role="button"` with Enter/Space), with hover, focus-visible and, when empty, disabled states.
- **Chip** `.chip` (+ `.yes .no .warn .info .accent`): status, side, or relationship labels. Text is required. Don't make chips clickable unless they're filters.
- **PlatformBadge** `PlatformBadge` (`PlatformLogo.tsx`, `.plat.pm|.ks`): the official platform marks (Polymarket icon on its blue; Kalshi “K” in its green on canvas), `role="img"` with the platform name. Colours come from `--color-platform-*`; paths use `currentColor`. Never redraw or recolour the marks.
- **DataTable** `table.dt`: dense rows, sticky header, right-aligned numbers, row hover reveals a row action (e.g. Simulate). Empty → EmptyState in the table body. Partial → a footnote row.
- **PayoffBar** `.payoff`: if-for / if-against two-sided bar for one position or event. Always labelled with the signed amount.
- **ChartFrame** `.chart`: SVG chart with axis labels, direct labels or a legend, and a tooltip. Must have a text alternative (table toggle or summary).
- **Callout** `.callout.info|warn`: a caveat or explanation with an icon. Don't stack more than 2 per card.
- **CoverageMeter** `.coverage`: share of reconciled data per source, with freshness. Required wherever net P&L is shown as exact.
- **InsightCard** `.insight`: pattern headline + plain explanation + sample size + one link. Must show `n =`. Don't use it when n < 5.

## Interactive layer (`web/src/components/`, styles in `web/src/styles/app.css`)
- **Menu** `Menu` (`.menu`): dropdown anchored to a trigger. Trigger gets `aria-expanded`; items must be `role="menuitem"`; arrow keys move, Esc closes and refocuses the trigger. Use for help, notifications, settings, account, "Add position". Don't use for page navigation.
- **Modal** `Modal`: a focused decision with Cancel + one primary action (guardrail, delete scenario, add to scenario, starting-portfolio switch). Traps Tab, focuses the first field (or `data-autofocus`), returns focus on close if that element still exists. Don't use for long lists (use Drawer).
- **Layer stack** (`overlays.tsx`): every Modal, Drawer and the palette register in opening order.
  - Esc closes only the topmost layer, so a child modal never takes its parent drawer with it.
  - Layers underneath are `inert`.
  - Page scroll is locked once and restored when the last layer closes.
  - Use `focusTopLayer()` after replacing a layer's content.
  - Never add a page-level Esc or scroll-lock handler of your own.
- **Drawer** `Drawer`: right-side detail list. Same focus and stack rules as Modal; Esc and scrim click close it. For positions, events, groups of holdings and trades, use the shared detail panels below instead of a page-specific drawer.
- **Detail panels** `DetailProvider` / `useDetails().open(detail)` (`details.tsx`): the one way to **inspect** something without leaving the current module. Position and event panels take the **origin `scope`** (platform filter) and start in it. The event panel offers an explicit Scope switch to All platforms and names holdings outside the scope. Payoffs are shown per outcome (YES / NO), labelled for/against only when the event is held on one side. Kinds: `position` (cost/value/unrealized, payoff, fills, source freshness), `event` (every contract across platforms, sides, quantities, value, committed capital, payoff for/against, relationships, data coverage), `group` (holdings behind a concentration or allocation bucket, with weights), `trades` (closed trades behind a figure; the subtitle states period and platform scope). Panels stack (event → position) with Back. Opening never navigates and never changes scenario state; cross-module actions in the footer are explicit and labelled (“Simulate in Scenario Lab” (hands off exactly the holdings in the panel's scope via `handoffPath`), “Analyze in Risk”). Keyboard openers must `preventDefault()` on Enter, otherwise the keypress activates the panel's Close button.
- **AddToScenarioModal** (Scenario Lab): confirms a hand-off from `handoffPath(ids, from)` (`lib/handoff.ts`).
  - Shows where the request came from and which platforms the holdings are on.
  - The user picks the target scenario (or a new one) and which holdings to include; positions already in that scenario are shown and skipped.
  - Added positions start at the current holding and mark (“No change”).
  - Cancel changes nothing.
  - Each request id is processed once (reload, Back/Forward and StrictMode never repeat it). A new deliberate action always opens the dialog again.
- **Allocation selection** (Overview `.al-btn`, `.seg-detail`, `.filter-bar`): allocation segments are toggle buttons (`aria-pressed`); hover previews are mouse-only (no sticky hover on touch); the donut centre shows the selected segment and its share. If the active Holdings filter belongs to the other grouping, the card says so with “Show by …” and Clear. Percentages name their denominator (share of segment vs. share of open value in scope). Selecting one shows its top positions and filters Holdings; a filter bar states the selection and has Clear. The basis is labelled (open-position market value, cash excluded). The selection is local: portfolio-wide figures never change. If the global platform scope removes the segment, the filter bar says so and all positions are shown.
- **CommandPalette** (⌘K): pages navigate; positions and events open their detail panel on the current page (never a scenario change). Group headings say what selecting does. Arrow keys + Enter.
- **Tabs** `Tabs`: real buttons with `role="tab"`; ←/→ move between tabs.
- **Switch** `.switch` (role=switch): a binary assumption (fees on/off). Don't use for view changes (use Segmented).
- **Select** `.select`: native select for long option lists (outcome-matrix events).
- **InfoTip**: "How calculated" popover on hover and focus; Esc closes. Text must match the definitions in `web/src/lib/finance.ts`.
- **InfoModal** (Help menu): the shared definitions list, and Data & privacy, which describes only what the current build does. *Clear saved scenarios & settings* asks for confirmation, removes only `scevia-` keys (`lib/storage.ts`) and reports failure instead of claiming success.
- **useConnect()** (`ConnectSources.tsx`): a contextual shortcut that navigates to Portfolio › Sources (or Coverage). There is no separate data-sources modal.
- **Staleness** `.stale`: warn-coloured source age when data is older than 24h. Pair it with an explanation of what “stale” means for the numbers.
- **AdjustmentRow**: replaced by `PositionRow`. Invalid input shows inline (`role="alert"`); that row is excluded from results and blocks Save. A funding shortfall is a status note (`role="status"`), not an error: the trade stays in the results as if funded.
- **Scenario status** (`lib/scenarios.ts`): `Not saved` / `Saved` / `Unsaved changes`, based on name + adjustments vs. the saved snapshot. Revert restores the snapshot.

## Feedback
- **EmptyState** `.empty`: one sentence + one action (e.g. "Clear filters").
- **Unavailable** `.unavailable`: say plainly when a metric can't be computed (too few trades, no prior period) instead of showing a guess.
- **Skeleton** `.skeleton`: matches final layout dimensions. Show it if loading takes > 300 ms.
- **Toast** `.toast`: confirmations ("Scenario saved"). Auto-dismisses after 4 s. Never used for errors that need action.

## Scenario Lab specific
- **LabHome** (`pages/lab/Home.tsx`, `.lab-home`, `.start-card`, `.scn-card`): the entry. Two start cards (*Modify current portfolio* with an inherited-portfolio preview `.start-facts` and its accounts; *Build from scratch* with optional starting capital per venue), saved-scenario cards (name, start, positions, value at marks, status), optional examples. No charts. Empty: “No scenarios yet”.
- **Scenario views** (`ScenarioLab.tsx`, `.lab-nav`): `Tabs` *Build · Analyze · Compare* under the page head; the Build tab shows a count flag when rows are incomplete. The SectionRail lists the current view's sections plus the scenario switcher (`.rail-keep`). Don't add a second navigation level.
- **AssumptionsBar** (`pages/lab/Setup.tsx`, `.assume-bar`): one line summarizing start, added capital, fees, constraints and price basis, with *Edit assumptions*.
- **AssumptionsDrawer** (`Setup.tsx`, `Drawer`): **FeeSetup** (*Provider estimate* with assumed role Taker/Maker, *Custom* % of notional, *Excluded*; every option changes the calculation), **Constraints** (verified relationships read-only; add/remove hypothetical *can’t both resolve YES* / *always resolve the same way* pairs between events in this scenario; duplicates blocked), **Methodology** (`details.adv`).
- **StartSetup** (`Setup.tsx`, `#setup`): starting portfolio (Seg, asks before changing what held rows mean) and capital per venue (`FundingInput`). Top of Build.
- **PositionsCard / PositionRow** (`pages/lab/Builder.tsx`, `.brow.brow-sel`):
  - **Toolbar:** *Size by* Seg (Shares / $ Amount / % of start, ⓘ explains the conversion) and *Add markets…*.
  - **Columns:** select, instrument (Held / New, reference price, resolution, account or funding scope), current, target in the chosen unit with the converted figure below, trade chip, assumed price with “Use reference …”, notional, est. fee, remove.
  - **Bulk bar** `.bulk-bar` (`role="toolbar"`) when rows are selected: *Use reference prices*, *Set target to 0*, *Reset to current size* (held only), *Remove from scenario*, *Clear selection*; states the remove-vs-exit difference; an `.undo-line` offers Undo.
  - **Layout:** a table above 1000px card width; 600–1000px: position on its own line, figures in one row; below 600px: two-column cards.
  - **States:** incomplete rows say what is missing; invalid rows are tinted with `role="alert"`; shortfall rows carry a status note; inputs keep the user's text while focused and show the committed value otherwise.
- **BuildSummary** (`Builder.tsx`, `#build-summary`, `.bs`): sticky beside the positions on wide screens. Starting cash, purchases, sales, est. fees (+ n unavailable), cash after trades (per venue), funding warning `.bs-warn`, value at marks and its change, settlement range, *Analyze this scenario*.
- **AddPositionModal** (`pages/lab/AddPosition.tsx`, “Add markets”): tabs *Your holdings* (checkboxes per account holding, *Select all*) / *Search markets* (provider, category, open-only, priced-only filters; error with *Try again*; stale responses dropped) / *Paste link*. Outcomes are toggle buttons (`.outcome-btn`, `aria-pressed`). One selection per scenario row across tabs. Footer basket `.addpos-basket` with removable chips and *Add N positions*. Disabled: closed/resolved markets and rows already in the scenario. Label: the catalog's “Sample market data”.
- **Analyze charts** (`pages/lab/charts.tsx`; every chart has an `aria-label` text equivalent and direct labels):
  - **RangeRows**: worst ○ — ● best per row with a tick for value at marks; no midpoint. Compact layout puts the range text above the bar.
  - **Waterfall**: totals and signed steps; the axis may start above zero and then says so (“Axis starts at …”).
  - **StackBars** `.stack-bars`: 100% bars per row; segments are buttons (`aria-pressed`) that filter a table; unavailable / empty states.
  - **PairBars** `.pair-bars`: before (outline) vs. after (solid, gain/loss) per row around zero; row labels can be links.
- **AnalyzeView** (`pages/lab/Analyze.tsx`): `.an-summary` (two primary `.an-big` + four `.an-mini`), Value bridge, Settlement range, Allocation (basis: open positions / incl. cash; by category / platform / event), Event exposure (worst settlement / committed), Resolution timeline (`.tl-months`, `.tl-list`), Outcome matrix, Payoff by event, Positions in detail (filter bar from allocation/exposure selection; *Edit* jumps to the row in Build and focuses it).
- **OutcomeMatrix / Dumbbell** (`pages/lab/Impact.tsx`): events come from the scenario's own start and result. “Not possible” cells name the linked constraints (followed through other events). Two events are needed for the matrix.
- **CompareView** (`pages/lab/Compare.tsx`): scenario picker `.pick-chip` (up to 5, plus the actual portfolio), basis Seg (Absolute / Change from start / % of own start), Settlement range (RangeRows), Capital deployment and Category allocation (StackBars), detailed table (setup rows incl. added capital **by venue** and starting value; each value with its change vs. its own start; “change unavailable”). A callout when setups differ.

- **LabHome three paths** (`.start-grid.three`): *Modify your current portfolio*, *Build from scratch* (capital per venue in its native asset) and *Historical replay*; saved cards say *Current market* or *Historical replay · hindsight*.
- **PriceCheckModal** (`pages/lab/PriceCheck.tsx`, from *Check latest* in the AssumptionsBar): frozen reference vs. latest reference vs. the user's assumed price per row; *Update N reference prices* only when something moved; assumed prices and targets never change.
- **Historical Replay** (`pages/Replay.tsx`, route `/scenario-lab/replay`, `.rp-*`): the same *Build · Analyze · Compare* tabs and assumptions bar.
  - **Build:** a hindsight callout; *Period & capital* (dates, fees, capital per account and asset); position rows `.rp-row` (outcome, account, entry date, execution price, size by shares / $ / % of capital, exit hold or sell on date with price; lifecycle errors inline, `role="alert"`); *Add markets* modal (period-aware, unavailable markets disabled with the reason).
  - **Analyze:** `.rp-kpis` (per-denomination ending value, realized P&L, fees, drawdown or why it's unavailable, indicative combined total); *Value over time* (a LineChart only with complete evidence, otherwise an `.unavailable` explanation); positions, cash flows and evidence tables.
  - **Compare:** `.pick-chip` picker (up to 4), a differences callout, and a table that marks non-comparable figures.

## Portfolio workspace (`pages/Portfolio.tsx`)
- **Layout:** a route rail (`/portfolio/:section`, NavLinks styled as the SectionRail) with Accounts · Sources · Transactions · Imports & reconciliation · Data coverage; page head with *Import CSV…* and *Add record…*. A record-management sample callout on Transactions and Imports only.
- **Account cards** `.acct-card`: name (ellipsis), kind chip, venue, sources, last observed, records and range, opening state, whether it's in the sample figures; review/unknown counts; actions *Transactions* (filtered link), *Import…*, *Add record…*, rename.
- **Sources** `.src-row`: sources in use per account (sample connections, CSV batches, manual), and *Add a source* with disabled connections.
- **Transactions:** filters in the URL (`role="search"`), selection scope bar `.sel-scope` (`role="toolbar"`: count and scope, *Select all N matching*, *Clear selection*, primary actions, *More…* resets, *Undo*), paginated `.rec-table`, `ConfirmBulk` preview, `RecordDetail` drawer (original vs. effective values, membership, identity, duplicate candidates as radio choices, explicit resets, correction form with *Fee unknown*).
- **Imports:** review and duplicate counters, import history table (batch id, account, relationship, status, *Records*, *Replace…*), `ImportFlow` (File → Account → Preview → Confirm → Result).
- **Data coverage:** the sample portfolio's per-account coverage table, the availability vocabulary, and the record-management sample's counts.
