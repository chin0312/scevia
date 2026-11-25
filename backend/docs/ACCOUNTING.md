# Phase 3 accounting and financial imports

The initial implementation separates normalized CSV observations, identity groups, accounting effects, and derived state. Import batches retain their normalized rows and owner-visible audit references. An atomic confirmation publishes a batch to replay. Replay derives the ledger on read from one set of active batches and posts no cumulative side effects. Existing provider endpoints continue returning source observations. Provider-native confirmed/final fills and supported cash movements in the same portfolio enter the same replay through a repeatable-read evidence window. A source reference identifies the stored record and normalized payload digest. Estimates, unresolved activity, and settlements without proven entitlement versus payment semantics stay separate.

## HTTP workflow

All paths below are under `/v1/portfolios/{portfolioId}` and require the portfolio owner's bearer credential.

| Operation | Contract |
| --- | --- |
| POST `/imports/preview` | JSON body with a `csv` string. Returns normalized rows, row validation issues, unresolved row count and an expiring batch ID. An invalid row rejects the entire preview. |
| POST `/imports/{batchId}/confirm` | Confirms the batch. Repeating confirmation preserves the original confirmation timestamp. Use `?replaces={priorBatchId}` to atomically supersede an entire confirmed batch with a corrected complete replacement. |
| GET `/imports/{batchId}` | Returns normalized observations and batch confirmation/supersession metadata. |
| GET `/accounting?asOf={ISO timestamp}` | Returns identity groups, ledger rows, holdings, cash by account and asset, and discrepancies. The optional cutoff uses economic timestamps. The result uses currently active corrections, including for earlier cutoffs. |

Preview expires in 30 minutes. Expired previews are inaccessible and purged on the next preview for that portfolio. Request bodies are bounded to 512 KiB, with 2,000 data rows and 25 active or preview batches and 250 retained batches per portfolio. Raw file bytes are not stored. Import evidence is data only and the API emits JSON. A production retention/deletion policy and configurable large-import handling are future work.

Use `GET /accounting/history?from=YYYY-MM-DD&through=YYYY-MM-DD` for up to 31 inclusive UTC end-of-day valuations, subject to a bounded replay work limit. Each point carries status and discrepancy count. Historical replay uses only evidence at or before that point.

## Canonical Scevia CSV

```csv
venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset
fixture,local,opening,2026-11-25T00:00:00Z,,opening_cash,,USDC,,,0,,
fixture,local,inventory,2026-11-25T00:00:00Z,,opening_inventory,,USDC,,,,,
fixture,local,deposit,2026-11-25T01:00:00Z,,deposit,,USDC,,,1000,,
fixture,local,buy-1,2026-11-25T02:00:00Z,,buy,yes,USDC,100,0.40,,0,
fixture,local,buy-2,2026-11-25T03:00:00Z,,buy,yes,USDC,100,0.60,,0,
fixture,local,sell-1,2026-11-25T04:00:00Z,,sell,yes,USDC,80,0.75,,0,
fixture,local,mark-1,2026-11-25T05:00:00Z,,mark,yes,USDC,,0.55,,,
```

Required headers can appear in any order. Optional columns are entitlement_id, related_event_id, counter_instrument, primary_basis_fraction, fee_timing and coverage_through. Cash amounts and fees are unsigned inputs with direction provided by the type. Supply stable event IDs scoped to venue/account. A transaction hash alone may represent multiple fills. Use a trusted event ID where available. Without one, keep the ID blank to retain the row as unresolved. Use a sequence to resolve position-changing events at the same time. Timestamps use offsets and up to millisecond precision. Exact normalized batch content is order-independent. Identical rows with the same stable ID across batches produce one event and preserve references to all source rows. Conflicting rows with the same ID are quarantined until corrected; an import row number never identifies an economic event.

An explicit opening_inventory row declares that omitted inventory starts empty for its account and collateral asset. An opening_position row can provide zero or positive inventory for one instrument and its known basis. Opening cash alone does not establish opening inventory. Opening cash, contributions, withdrawals, standalone fees, rewards and rebates use amount. Opening position requires instrument and quantity; amount is total basis and may be omitted. Buy and sell require instrument, quantity and unit price. A blank fee is unknown; use explicit zero for a known fee-free transaction. Fee asset defaults to the collateral asset. Settlement uses quantity and per-unit payout. Redemption uses quantity and actual cash received. Marks use instrument and price. A standalone user-declared binary complete-set conversion can supply two distinct instruments, equal token quantities, one collateral unit per pair and a primary basis fraction. Incomplete conversions remain unresolved.

Only this format is supported. Kalshi documents CSV export availability but the exact schema and version were not verified for a reliable mapping. No Polymarket export mapping was verified. See [Kalshi Trading History](https://help.kalshi.com/en/articles/13823848-trading-history).

## Calculation convention and availability

Weighted average cost gives a single reproducible basis for partial exits. Buy fees in the settlement asset enter basis. Sell fees reduce proceeds. Cross-asset fees are separate cash effects and prevent an exact single-asset P&L where conversion would be needed. Unavailable buy fees invalidate basis; unavailable sell fees invalidate realized proceeds. A full exit releases all remaining basis and a subsequent buy starts a new holding. The engine uses decimal strings, 70-digit working precision, and half-even rounding for repeating divisions. The method serves portfolio analysis rather than tax-lot reporting. Provider averages and existing frontend sample metrics require separate comparisons.

Deposits and withdrawals change net contributions. Blank opening cash leaves cash balance unknown even when cash changes are available. Settlement removes inventory, releases basis, recognizes gain/loss, and records an entitlement. Full and partial redemptions move a uniquely identified entitlement to cash with no second realization. An optional entitlement_id references the settlement row ID. An ambiguous match, amount mismatch or over-redemption is unresolved. Asset balances are separate without implicit conversion.

A mark applies only at or after its timestamp. An imported mark is estimated and stale after 24 hours. Valuation excludes look-ahead and returns null when required marks, opening cash or relevant amounts are missing. In the fixture above at 05:00 the independently expected and tested results are basis 60, average cost 0.50, 120 shares, cash 960, market value 66, realized 20, unrealized 6 and portfolio value 1,026. A mixed portfolio reports partial results. Unknown cost, fees and unmatched observations remain visible, with known amounts explicitly scoped to posted effects.

## Handoff and review gates

Phase 2B should show imported, estimated, provider-reported and unavailable amounts distinctly. Phase 4 should consume replay results only with their coverage and discrepancy status. A normalized archive and independent replay are available now. Explicit provider-to-CSV links and latest available snapshot comparisons are implemented. General venue conversions, automatic cross-source matching, unverified settlement or cash identities, and historical series beyond the bounded daily endpoint remain outside the supported subset. Existing Phase 2A data-use gates remain. No live financial records were queried in this phase.

For future chain evidence, the MIT [Subgraph V2 exchange handler](https://github.com/psyberck/polymarket-subgraph-v2/blob/main/src/handlers/ExchangeMapping.ts) models decoded fill fees and cost basis with log identity. Use it as a reference for role, collateral and reorganization tests; no source code or dataset was incorporated into this implementation.

## Unified evidence and availability

- Preview may accept an owned providerAccountId and sourceLinks mapping CSV event IDs to existing source-record UUIDs in that account. References outside that account are rejected. An explicit link plus matching event time, asset, canonical instrument UUID and normalized financial fields coalesces the observations. A changed provider record is replayed from its current digest. If an import no longer agrees it is marked conflicting; the eligible provider record remains the primary observation. Similar transactions, labels and transaction hashes do not imply equivalence.
- Preview shows proposed event matches and discrepancies without posting them. Replay on confirmed records evaluates links again against current evidence. Listing distinguishes preview, active, superseded and expired batches. Reconfirming a superseded batch returns a conflict rather than restoring it.
- Use the canonical instrument UUID from a provider event when linking a provider-backed row. Unlinked imports that explicitly supplement a connected account start as overlap candidates unless the owner confirms nonmatching rows with acceptUnlinked. Independent imported accounts are scoped by their account UUID even when they share a venue with a connected account. Unmatched standalone instruments retain their import identity; no name-based instrument matching is used.
- Snapshot comparisons show reported and reconstructed components at the snapshot timestamp, the observed-minus-reconstructed difference, latest position-membership evidence, and freshness relative to the requested cutoff. A matching event component does not prove complete history. A missing row is never promoted into a zero snapshot or a balancing transaction.
- Replay execution, overall partial status, account opening and per-metric availability are separate. A dispute affects its account and collateral scope, while independently usable accounts remain visible. Provider deposits and withdrawals are cash effects; their investment contribution classification is unknown. A historical mark must be timestamped and eligible at the cutoff. Retrieval-only Polymarket marks are excluded, same-time conflicting marks are unavailable, and the 24-hour freshness policy remains.
- An explicitly linked execution-fee observation with fee_timing set to execution_evidence can agree with an attached fee without being charged again. A linked fee or rebate with separate_cash_flow, or no declared timing, posts separately at its own timestamp. A unique eligible execution-fee observation can supply an otherwise missing trade fee in the same asset when the parent posts. If the parent cannot post, reconciliation reports the unposted fee evidence. Conflicting, ambiguous or unverified fee allocation remains a discrepancy. Provider estimated fees are not promoted to actual fees.
- The standalone split of 100 collateral into 100 units per leg with a 40/60 basis allocation yields basis 40 and 60, with zero gain. Merging 25 pairs returns cash 25, releases basis 10 and 15, and keeps 75 units per leg and zero gain. This is user-declared complete-set accounting. No venue contract verification is implied. Provider conversion facts remain unresolved without trustworthy complete legs.

The API reports one reconstructed asset bucket per financial account and asset. It supplies no currency-converted aggregate. Use the known components and availability fields for Phase 4. A bounded daily valuation applies current accepted corrections to prior economic cutoffs, and is not a time-of-publication audit series.

## Owner-controlled transaction management

The following endpoints are relative to `/v1/portfolios/{portfolioId}`. Accounting continues to consume the source evidence and an independent, append-only log of portfolio decisions. An exclusion or duplicate decision removes a selected observation from replay and leaves the original evidence accessible. A material provider revision leaves exclusions in place and makes the changed revision visible. A stale include or correction requires review. Excluding one source observation does not remove other observations that support the same economic event.

| Method and route | Contract |
| --- | --- |
| POST `/accounting/accounts` | Create an independent account with `venue` and `label`. The returned portfolio-owned UUID is stable. Use it as the import preview's `providerAccountId`. |
| POST `/accounting/manual-records` | Add one normalized JSON `event` to an owned independent account. Provide `accountId` and a stable client UUID `clientId`. Retrying the same client ID and values returns the same record key. |
| GET `/accounting/records` | List paginated normalized observations. Filter by `account`, `venue`, `instrument`, `type`, `batchId`, `source`, `inclusion`, `from`, `through`, `duplicates`, `search`, or exact `key`. Each item includes its original and effective values, acquisition, revision, decision, and candidate overlap examples. |
| POST `/accounting/adjustments/preview` | Provide up to 200 explicit `changes` or one bounded `selection`. Return frozen revision and before/after holdings and cash. |
| POST `/accounting/adjustments/confirm` | Submit the same request plus the preview revision. Stale selections or affected evidence return 409 and require a fresh preview. A successful bulk application is atomic. |

An explicit change contains `key` and `action`. Actions are `include`, `distinct`, `exclude`, `restore`, `correct`, and `duplicate`. A duplicate decision names an included same-account, same-type, same-asset `duplicateOf` record. A correction supplies a validated JSON `correction` patch for an imported or manual row; use batch replacement for complex legs or linked observations. Restore resets the local decision to normal replay eligibility. Distinct and explicitly included unresolved imports use a generated local key where needed and remain user-accepted. Unverified provider rows cannot be promoted by this API. Candidate overlap hints use identical normalized economic terms and do not automatically merge different economic IDs.

For filtered changes, send `selection` with an account, batch or instrument filter, an action of include/exclude/restore, optional event type or inclusion status, and optional `except` keys. A new matching record or a changed affected account invalidates the review digest. This supports selection across pages without silently including newly arrived records. Permanent source-data deletion remains a future secure workspace operation.

### Supplemental imports and review consistency

- For new standalone accounts, create an account explicitly rather than reusing a label. Legacy standalone batches keep their existing normalized account labels. CSV rows may supplement the owned connected account supplied to preview. `acceptUnlinked: true` is an explicit user choice to include rows with no exact overlap candidate as user-accepted. Individual unresolved observations remain inspectable and can be accepted through the adjustment flow. Source links still require an owned source record and exact normalized equivalence.
- Pass `replaces` when previewing corrections. The replay preview removes the prior batch before adding the candidate. Confirmation must use the same replacement target and current reviewed evidence. Pass the returned `reviewRevision` to bind confirmation to the revision shown to the user. Older unconfirmed previews must be reviewed again.
- The transaction view separates original values from a proposed or effective correction. Use ledger and discrepancy references to explain why a particular effective record could not post. Reconciliation management excludes or restores evidence rather than deleting it.

### Phase 4 consumption contract

Treat `replayStatus` as execution, and `portfolioScope` as the evidence selection. Opening cash and inventory are separate declarations from history. A `history_complete` CSV record with `coverage_through` declares a bounded interval and appears as user-declared coverage; it does not prove upstream completeness. Cash, realized results and valuation for selected evidence carry availability fields, and `fullAccountValue` remains null where whole-account completeness is not established. Holdings include observed closed inventory separately from missing positions. Basis, estimated market value and settlement fields describe known components when inventory history is incomplete.

Use the snapshot comparison's scope and timestamp. A comparison against a user-selected set can differ legitimately from a provider account snapshot. Current membership metadata cannot establish membership for an earlier cutoff. Use historical daily points for selected-evidence valuation and carry forward uncertainty rather than deriving a separate finance ledger.

The reference portfolio yields value 1,026. After an owner resolves an accidental duplicate and deliberately excludes the first purchase, the selected replay yields 20 shares, basis 12, cash 1,000, realized 12, unrealized -1 and value 1,011. Restoring that purchase returns the replay to 1,026.
