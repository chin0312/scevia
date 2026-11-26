# Frontend API integration

The backend owns effective accounting, performance, risk and scenario results. Bind PR #1's view models to these APIs during coordinated integration. Keep sample mode separately selectable. Connected screens should display missing, partial and stale data at the original scope. Financial amounts, quantities, prices and weights are decimal strings.

## Portfolio and source lifecycle

| Workflow | API and behavior |
|---|---|
| Discover capabilities | `GET /v1/providers` lists technical adapter capabilities. Kalshi `liveAccess` describes public authorization for this process. `accountAccess: credential_verification_required` means a local account binding is configured and the private acquisition path still needs a successful scope check. Use account sync and coverage to show observed operational state. |
| Choose a portfolio | `GET /v1/portfolios` lists portfolios owned by the current development principal. `POST /v1/portfolios` creates one. Carry its ID in all account, import, analytics and scenario requests. |
| Connect Polymarket | `POST /v1/portfolios/{id}/sources/polymarket` tracks the explicitly selected wallet address. Its address proves neither ownership nor related wallet identity. Public and account reads depend on configured authorization. |
| Connect Kalshi | [Local administrative setup](KALSHI.md#authorized-local-setup-and-verification) registers an owned provider account and binds an owner-only key file. The UI uses the source ID and never handles key material. Keep demo-prefixed catalog identifiers intact for scenario selection. |
| Import | `POST /v1/portfolios/{id}/imports/preview` provides validation and reconciliation. Confirm the reviewed batch via `POST /v1/portfolios/{id}/imports/{batchId}/confirm`. Batch listing exposes superseded imports. [Import and adjustment contracts](ACCOUNTING.md) |
| Refresh | `POST /v1/provider-accounts/{id}/sync?scope=current` prioritizes positions and balances. Use `scope=history` for bounded work and let existing leases arbitrate conflicts. A 409 means review the current run before retrying. |
| Inspect refresh evidence | `GET /v1/portfolios/{id}/coverage?providerAccountId=...` gives per-entity status, source time, attempt and successful refresh times. `GET /v1/portfolios/{id}/sync-runs` gives stream status, cursor progression, diagnostics and snapshot publication. The synchronous refresh response has a status and a `streams` array whose entries include `streamName`, `status`, `recordsPersisted`, and `errorCode`. |

Credentials and production authentication, source disconnect, export and deletion require separate release work. Distinguish the user's Scevia identity from provider sources. Example Kalshi setup errors include `provider_live_disabled`, `kalshi_read_scope_unverified`, `kalshi_account_scope_unverified` and `kalshi_credential_unavailable`. Preserve errors and per-stream coverage even when other streams return data.

## Overview, transactions and analytics

- Use `GET /v1/portfolios/{id}/accounting?view=summary` for reconstructed state. Raw `/positions` and `/cash-balances` are provider observations. Position rows carry freshness and membership indicators. An unobserved row is uncertain and an explicit zero is a separate case. An old balance and a new position snapshot may have different as-of dates.
- Use `/accounting/records` for pagination, filtering and selection. The `/accounting/adjustments/preview` and `/accounting/adjustments/confirm` flow supports reviewed corrections, exclusions, restores and duplicate choices. Preserve effective and source values, and re-preview after a stale revision response. Raw `/fills`, `/cash-movements`, `/settlements` and `/activity-facts` are separate provenance views. A source fact awaiting reconciliation has no guaranteed ledger effect.
- Discover venue/account scopes and assets with `/analytics/scope`. Call `/analytics/performance` and `/analytics/exposure` with a common UTC `asOf`, asset and account scope. Preserve return gaps, unavailable reasons, ledger revision, catalog revision and settlement-rule revision. Respect the reported denominator and mapping coverage of allocation rows. A supported settlement subset can be mathematically exact with incomplete overall portfolio evidence. [Analytics contracts](ANALYTICS.md)
- Use `/analytics/denominations` for the native groups. Its optional `assumedUsdPerUsdc` is a reporting assumption with separate availability. Retain unsupported or unknown components and keep cash and contractual exposure scoped to account and denomination.

## Market selection and Scenario Lab

Use `GET /v1/market-data/search` or `POST /v1/market-data/resolve` for Polymarket. Kalshi has separate ticker lookup, listing, link resolution and archived history under `/v1/market-catalog/kalshi`. Preserve the venue and outcome ID, select one explicit outcome, keep independent cursors, and distinguish timestamped price observations from retrieved last-trade values. Missing prices and unsupported fee or payout models remain visible.

All scenario paths are under `/v1/portfolios/{id}/scenarios`. Preview an actual or scratch baseline with `POST /baseline`; evaluate the draft with the returned `baselineToken` via `POST /evaluate`. Extend an existing draft with `POST /baseline/instruments`, then use the returned token and baseline source for subsequent evaluation and save. A fresh `POST /baseline` deliberately recaptures. Persist with the current optimistic revision, and confirm a rebase with the exact reviewed token, candidate input and revision. Comparison preserves independent fee, funding, valuation and settlement compatibility flags. [Scenario API](SCENARIOS.md)

For an explicitly selected connected Kalshi USD snapshot, send `useReportedKalshiSnapshot: true` with the actual baseline source. Display quantity and cash source references, leave missing inventory open, and distinguish `holding_no_longer_observed` from closure on rebase. The current evaluator accepts one reporting denomination per scenario. Independent funding buckets preserve actual account identity and may hold scenario-only starting capital. Present known shortfalls alongside unavailable aggregate funding, and show whether allocation and settlement results cover the complete scenario or a subset. Record when deliberately captured public quotes are newer than the financial cutoff. Conditional payout models belong to scenario results and leave reviewed actual risk unchanged.

Run the connected handoff only after Phase 6B evidence review. The current backend contract, sample UI and eventual production onboarding are three separately verifiable milestones.
