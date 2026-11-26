# Continuous tracking and product integration handoff

Phase 6 merged the provider and ledger foundation, owner-scoped demo refresh, persisted scenarios and qualified valuations. Phase 7 established the continuous tracking foundation. Phase 8 implements bounded Historical Replay, Phase 9 owns authorized real-data acquisition and validation, Phase 10 integrates the backend with PR #1 across all four modules, and Phase 11 covers secure release and external Beta testing.

| Consumer | Backend contract | Integration requirements |
|---|---|---|
| Overview | Strict accounting plus separately labelled last-known reference values | Distinguish independent market, account, and valuation freshness. Retain original mark times and coverage. |
| Analytics | Account- and instrument-scoped historical valuation with `carry_forward_reference_estimate`, oldest reference time, stale count and return eligibility | Plot carried values as estimates. Preserve actual gaps for missing initial marks or unresolved financial state. Qualify returns and drawdown. |
| Risk | Scoped observed exposure, concentration and reviewed settlement results | Present known components separately from complete NAV. Use event evidence and unsupported reasons. |
| Scenario Lab and Historical Replay | Frozen, revisioned single- or mixed-denomination scenarios, and the shared ledger for simulated trades and derived settlement | Track actual trading availability at historical cutoffs, price simulated executions from eligible observations, and keep real receipts and hypothetical consequences separate. Implement Historical Replay in Phase 8. |

Continuous refresh needs shared authorization-aware caching, retry/reconnection and independent revaluation scheduling. The backend refresh operation is idempotent and preserves prior evidence. Keep live and saved valuations distinct during Phase 10 integration. Provider permissions, populated accounts, supported RPC, approved exports and independent statements remain prerequisites for real-data acceptance. Phase 11 adds production identity, retention, export/delete, operational safeguards and external testing.

## Continuous operation

Phase 7 owns shared authorized market-price storage, source-aware quote deduplication, historical aggregation, retention and bounded storage. Share history across workspaces and retain independent account synchronization. Revalue affected portfolios incrementally and recover interrupted refresh from durable progress. Measure representative workload and cost before choosing production retention and cadence. The current 2,000-quote manifest and 500-revision workspace bounds support local validation. Phase 11 owns production identity, external access and user-testing gates.

## Phase 9 authorized validation inputs

1. Written provider and Polygon RPC permission covering the intended endpoints or exports, data retention and display, including a scoped read-only Kalshi credential or an approved export. Supply the approved Polygon RPC endpoint and representative wallet address, transaction hashes and date range through the configured access path.
2. Approved populated Kalshi account or exports and Polymarket activity for the same declared cutoff, plus independent opening/ending cash, fills, fee and rebate totals, positions, settlements, redemptions and P&L. Include ambiguous events and a representative history size.
3. A reviewed real-demo plan with active and resolved market identities, native collateral, eligible price and trading-window evidence, verified resolution evidence, and independently calculated expected simulated results.

The finalized CTF Exchange V2 receipt reader covers exact transaction evidence. Historical transaction discovery, other exchange generations, execution-fee/rebate and collateral activity attribution, settlement/redemption reconciliation, broader Kalshi settlement and fee coverage, and account-history scale validation remain open.

See [continuous tracking operations and contracts](CONTINUOUS_TRACKING.md) for the implemented worker and outstanding Phase 9 live-data work.
