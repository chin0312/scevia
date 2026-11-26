# Backend Demo Portfolio

The three portfolio modes in `GET /v1/portfolios` are `fixture`, `demo`, and `actual`. The fixture seed is synthetic. A demo uses approved market evidence, simulated cash and explicitly hypothetical financial records. An actual workspace uses user-selected financial evidence. Demo funding and instruments cannot connect to personal provider accounts or be included in another portfolio's native history.

## Set up the local demo

Confirm written permission to collect, retain and display the intended public-market capture from each provider. Supply a curated capture with production market and event identifiers, native YES and NO instruments, lifecycle and timing, source provenance, real timestamped prices, and a confirmed standard payout if simulating a resolved market. Choose the virtual capital and trades independently. Include appropriate authorization for any previously captured evidence and keep the capture file outside source control.

```sh
cd backend
npm run --silent demo:dataset -- schema > /tmp/scevia-demo.schema.json
npm run demo:dataset -- validate /absolute/path/to/authorized-demo.json
export DEMO_CAPTURE_AUTHORIZED=YES
export DEMO_DATASET_PATH=/absolute/path/to/authorized-demo.json
npm run db:migrate
npm run dev
```

The manifest uses `evidenceKind: "authorized_capture"`, `capturedAt`, `markets`, `quotes`, `capital` and `trades`. The schema command documents field shapes. The validator also checks references, currencies, market identities, chronology and trade eligibility. Operators must validate the underlying capture provenance. The manifest has no credential fields. Fixture manifests are accepted only by the injected test assembly.

Each trade refers to a zero-based quote index. Optional `executionAt` records a simulated execution after an eligible prior observation. The demo API exposes the reference index, execution time and `prior_observation` qualification. Market opening and trading close are distinct from expected resolution, verified resolution and simulated payout time. Known trading windows and resolution bounds are enforced. When historical trading timestamps are missing, the seeded execution is an assumption with unverified trading availability. A candle close may be used at its provider observation time. A midpoint without a source timestamp becomes eligible at retrieval time. Historical executions are simulated at a reference price, with an assumed fee, and do not establish that someone could have executed at that price. An unknown fee remains unknown. Settlements require independently verified standard dollar-unit resolution evidence and occur at its known time. A demo payout is simulated. The shared ledger derives quantity from the effective pre-resolution inventory for each replay. Corrections, exclusions, restorations and partial exits therefore affect entitlement, proceeds and basis. Payout defaults to the resolution-evidence timestamp, or a declared simulated timestamp on or after it. A resolved market with unverified payout stops the open-price reference without posting cash. Actual provider receipts remain separate evidence.

## API and verification

```sh
api=http://127.0.0.1:3001/v1
auth="Authorization: Bearer $DEV_AUTH_TOKEN"
curl -fsS -H "$auth" "$api/demo"
curl -fsS -H "$auth" -H 'Content-Type: application/json' -X POST -d '{}' "$api/demo"
```

An initialized response contains `status: "available"`, `mode: "demo"`, `portfolioId`, `revision`, `capturedAt`, `marketEvidence: "captured"`, `transactions: "hypothetical"`, and market and quote arrays. The quotes retain their original methodology and clock and report freshness separately. A missing authorized dataset returns `authorized_demo_dataset_unavailable`. It cannot trigger fixture fallback.

Use the returned portfolio ID for accounting, transaction corrections, historical performance, exposure and scenarios. Begin with `capturedAt` as the valuation cutoff. Inspect a known historical date before settlement, check open holdings and reconciled cash at capture, review and confirm a quantity change, and compare revised basis and cash. Then save and resume a scenario and compare it against an alternative. Use the same financial APIs as an actual portfolio.

`POST /v1/demo` resumes the current workspace. For an explicit reset, send `{ "resetFromPortfolioId": "<current portfolio UUID>" }`. Reset creates a clean owner-scoped workspace from the currently configured capture and preserves the earlier workspace and scenarios. The prior workspace remains available through the owned portfolio APIs. A competing reset against the previous ID returns 409. Current edits are isolated to the owner and never alter the dataset or another workspace.

## Refresh and retention

For an initial capture, supply a plan with native Kalshi tickers or supported Polymarket links and condition IDs, virtual capital, and explicit trade side, quantity, fee assumption and observation time. For Polymarket, supply the independently verified collateral denomination. Seeded trades default to an exact reference. For older windows, include permitted, timestamped `capturedHistory` rows in the plan with provider, native market and outcome IDs, original observation and retrieval times, source, price and `historical_close` method. The CLI uses matching imported observations before requesting provider history. To use a prior reference, supply `executionAt` and `priorObservationMaxAgeSeconds`. The latest matching observation within that bound is eligible. The age limit is seven days, independent of how old the historical window is.

Polymarket public metadata alone leaves payout unresolved. To incorporate independently reviewed standard resolution, add `resolution` to the selected Polymarket market in the capture plan. Supply the known time, exact winning native outcome token, unit payout `1`, and `evidence` with source `reviewed_provider_evidence`, a reference to the retained provider or on-chain proof, and `verifiedAt`. The operator must independently verify the condition, outcome tokens, payout, timestamps and collateral. The CLI validates scope and chronology. The provenance reference records the review and is never fetched. Install the resulting approved capture and apply the same workspace refresh to incorporate evidence for an existing market.

```sh
npm run --silent demo:dataset -- capture-schema > /tmp/scevia-demo-capture.schema.json
npm run demo:dataset -- capture /absolute/path/to/approved-plan.json /absolute/path/to/authorized-demo.json
```

When authorized, refresh a batch in the curated capture using the existing unsigned Kalshi and Polymarket public services.

```sh
npm run demo:dataset -- refresh /absolute/path/to/authorized-demo.json /absolute/path/to/next-demo.json 0 12
npm run demo:dataset -- validate /absolute/path/to/next-demo.json
```

Each run accepts an offset and a limit of up to 12, and reports a next offset. Pass each resulting capture forward through the remaining pages. A failed page keeps earlier evidence and its original time. Market lifecycle and standard Kalshi resolution can advance without a midpoint. Each quote keeps its own timestamp. The local cache defaults to 60 seconds.

Phase 9 authorized validation requires a permitted real capture and a manual financial check against the captured market evidence. Automated tests use a separately labelled injected fixture. Phase 11 owns production guest identity, privacy and user-data deletion.

To apply a newer approved capture without resetting, send `{ "portfolioId": "<workspace ID>", "revision": "<current revision>" }` to `POST /v1/demo/refresh`. Updates require exact native event, market, asset and outcome associations and monotonic lifecycle. The workspace keeps existing instrument IDs and user trade decisions. Repeated refresh with the returned revision is idempotent. Previously saved scenarios stay frozen, and newly selected markets remain a reset or explicit scenario-selection workflow. A successful refresh advances the single managed simulated history interval through the supported capture cutoff. `simulated_ledger_complete` denotes compatible opening state and an internally managed financial interval. Return metrics still require usable valuations and resolved financial evidence. Price coverage and market freshness retain independent timestamps. User-declared and actual provider history intervals remain source-bound.

Material lifecycle, trading window, expected resolution, fee and payout changes retain past metadata. An identical observation updates `latestRetrievedAt` without creating a historical revision. Conflicting resolution evidence returns `demo_resolution_conflict` and requires operator review. The 2,000-quote and 500-prior-market workspace limits are local validation bounds. See the [Phase 7 handoff](PHASE7_HANDOFF.md) for continuous acquisition and storage requirements.
