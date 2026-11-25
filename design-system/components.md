# Component inventory

Load this file when building or changing UI. **Reuse before creating.** Adding a component means adding an entry here in the same change.
Reference implementation (concept stage): `design-concepts/v2/assets/components.css`. Class names below are the concept classes.

Required states for every interactive component: **default, hover, focus-visible (2px `focus-ring`), active, disabled**. Data components also need **loading (skeleton), empty, error, partial-data**.

## Shell
- **AppShell** `.shell`: top bar + left section rail + main. Use for every product page. Don't use for modals or onboarding.
- **TopNav** `.topbar`: brand wordmark (`/brand/scevia-logo.png`, 28px tall), the 4 areas (Overview, Analytics, Risk, Scenario Lab), utilities on the right (search ⌘K, sync status, data-mode chip, help, alerts, settings, avatar). Don't add more top-level areas. New things become sections.
- **SectionRail** `SectionRail` (`.rail`, `.rail-sub`): this page's sections as jump links. Cards that share a row are **one group** (the row container has the group id) with one child entry per card, so side-by-side cards never compete for the active state. Scroll-spy tracks groups only. A click (or a `#hash` link) scrolls to the target, focuses it (`tabindex=-1`) and flashes it (`.section-flash`), and keeps that entry active until the user scrolls themselves (wheel, touch, PageUp/Down, arrows, Home/End, Space); reaching the bottom of the page never overrides it. Exactly one entry has `aria-current="location"`. Programmatic jumps (“Show in Holdings”) call `scrollToSection(id)` so they behave like rail clicks; scrollbar drags and Back/Forward release the lock too. The spy offset is measured from whatever is sticky (top bar, and the rail when it is a horizontal bar). Also holds saved scenarios and one context card. One level of children at most.

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
  - Settings is hidden (its items stay reachable from the data chip, Help and Risk).
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
- **DataSources** `useConnect()` (`ConnectSources.tsx`): the active source (sample portfolio) and the user-selectable source types: Polymarket public wallet, Kalshi read-only account, File import (CSV, any provider). Actions that don't work in this build are disabled with a reason. Never simulate a connection, upload, sync or verification.
- **Staleness** `.stale`: warn-coloured source age when data is older than 24h. Pair it with an explanation of what “stale” means for the numbers.
- **AdjustmentRow**: replaced by `PositionRow`. Invalid input shows inline (`role="alert"`); that row is excluded from results and blocks Save. A funding shortfall is a status note (`role="status"`), not an error: the trade stays in the results as if funded.
- **Scenario status** (`lib/scenarios.ts`): `Not saved` / `Saved` / `Unsaved changes`, based on name + adjustments vs. the saved snapshot. Revert restores the snapshot.

## Feedback
- **EmptyState** `.empty`: one sentence + one action (e.g. "Clear filters").
- **Unavailable** `.unavailable`: say plainly when a metric can't be computed (too few trades, no prior period) instead of showing a guess.
- **Skeleton** `.skeleton`: matches final layout dimensions. Show it if loading takes > 300 ms.
- **Toast** `.toast`: confirmations ("Scenario saved"). Auto-dismisses after 4 s. Never used for errors that need action.

## Scenario Lab specific
- **Scenario setup** (`Setup` in `ScenarioLab.tsx`):
  - starting portfolio (Seg);
  - added capital per platform (`FundingInput`);
  - **FeeSetup:** *Provider estimate* (with assumed role Taker/Maker), *Custom* (% of notional) or *Excluded*. Every option changes the calculation.
  - **Constraints** (`details.adv`, collapsed unless the scenario has some): verified relationships shown read-only; add or remove hypothetical *can’t both resolve YES* / *always resolve the same way* pairs between events **in this scenario**; duplicates are blocked.

  A read-only **Facts** block separates source facts and fixed methodology from user assumptions. It always comes before results.
- **Portfolio builder row** `PositionRow` (`pages/lab/Builder.tsx`, `.brow`): one grid row per position.
  - **Columns:** instrument (Held / New), current shares, target-shares input, trade chip, assumed-price input with “Use reference …”, notional, estimated fee, remove.
  - **Layout:** a table on wide cards; at ≤1000px card width (container query) each row restacks into a two-column card.
  - **States:** incomplete rows say what is missing, invalid rows are tinted with `role="alert"`, and shortfall rows carry a status note.
- **AddPositionModal** (`pages/lab/AddPosition.tsx`), with tabs *Your holdings* / *Search markets* / *Paste link*.
  - It talks only to the `MarketCatalog` interface (`lib/markets.ts`) and labels results with the catalog's label (“Sample market data”).
  - Outcomes are buttons (`.outcome-btn`), disabled for closed or resolved markets and for instruments already in the scenario.
  - Link states: invalid, unsupported provider, not found, unavailable, multiple markets, resolved.
- **AllocationImpact** (`pages/lab/Impact.tsx`): before/after market-value table by category, platform or event, with % of open-position value, change in points, New/Exited chips, cash share, and paired bars (hidden on narrow cards).
- **OutcomeMatrix / Dumbbell** (`pages/lab/Impact.tsx`):
  - Events come from the scenario's own start and result, never from a fixed list.
  - Two events are needed for the matrix; empty states otherwise.
- **Compare** (`ScenarioLab.tsx`):
  - setup rows (starts from, added capital, fees, hypothetical constraints);
  - each value with its change *vs. its own start*;
  - “change unavailable” when either side is unavailable;
  - a callout when starts differ.
- **AdjustmentRow** `.adj`: position + action chip (Buy / Sell / Exit / No change) + Slider + hypothetical price Field + cash impact.
- **BeforeAfterTable** `.ba`: metric · current · scenario · change (DeltaBadge, colour by "better for the user", not by sign).
- **OutcomeMatrix** `.matrix`: 2×2 (or 2×N) joint outcomes, each tile shows scenario P&L, "was" P&L, and the change. Unknown dependencies → `warn` chip on the card.
