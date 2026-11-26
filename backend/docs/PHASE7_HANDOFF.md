# Phase 7 product integration handoff

Phase 6 supplies provider and ledger contracts, owner-scoped demo refresh, persisted scenarios and qualified valuations. Populated provider and real-demo acceptance remain separate Phase 6 gates. Phase 7 integrates these services with the four-module frontend, adds scheduled market acquisition and incremental account sync, revalues affected portfolios, and validates bounded Historical Replay internally. Phase 8 covers secure release and external user testing.

| Consumer | Backend contract | Integration requirements |
|---|---|---|
| Overview | Strict accounting plus separately labelled last-known reference values | Distinguish independent market, account, and valuation freshness. Retain original mark times and coverage. |
| Analytics | Account- and instrument-scoped historical valuation with `carry_forward_reference_estimate`, oldest reference time, stale count and return eligibility | Plot carried values as estimates. Preserve actual gaps for missing initial marks or unresolved financial state. Qualify returns and drawdown. |
| Risk | Scoped observed exposure, concentration and reviewed settlement results | Present known components separately from complete NAV. Use event evidence and unsupported reasons. |
| Scenario Lab and Historical Replay | Frozen, revisioned single- or mixed-denomination scenarios, and the shared ledger for simulated trades and derived settlement | Track actual trading availability at historical cutoffs, price simulated executions from eligible observations, and keep real receipts and hypothetical consequences separate. Schedule and implement Historical Replay in Phase 7. |

Continuous refresh needs shared authorization-aware caching, retry/reconnection and independent revaluation scheduling. The backend refresh operation is idempotent and preserves prior evidence. Keep live and saved valuations distinct on PR #1's eventual frontend. Provider permissions, populated accounts, supported RPC, approved exports and independent statements remain prerequisites for real-data acceptance. Phase 8 adds production identity, retention, export/delete, operational safeguards and external testing.
