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

Each trade refers to a zero-based quote index. A candle close may be used at its provider observation time. A midpoint without a source timestamp becomes eligible at retrieval time. Historical executions are simulated at a reference price, with an assumed fee, and do not establish that someone could have executed at that price. An unknown fee remains unknown. Settlements require independently verified standard dollar-unit resolution evidence and occur at its known time. A demo payout is simulated. The model uses the same entitlement and redemption effects as actual accounting.

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

When authorized, refresh the open markets in a curated capture using the existing unsigned Kalshi and Polymarket public services.

```sh
npm run demo:dataset -- refresh /absolute/path/to/authorized-demo.json /absolute/path/to/next-demo.json
npm run demo:dataset -- validate /absolute/path/to/next-demo.json
```

Refresh is bounded to 12 selected market entries per run. A Polymarket market needs its supported `publicLink`. Kalshi requests require the production market environment and public-data authorization. Failed lookups retain the original captured data and time, and a wholly unavailable refresh writes nothing. The command appends eligible marks to a separate output without changing trade references. Updating the configured path or atomically replacing its content allows subsequent reset/initialization to use the new revision. Existing workspaces stay pinned. The local manifest cache defaults to 60 seconds. New resolutions, historical candles and larger curated universe changes require a reviewed capture revision.

Phase 6B requires a permitted real capture and a manual financial check against the captured market evidence. Automated tests use a separately labelled injected fixture. Production guest identity, retention and deletion are Phase 7 work.

To add eligible new midpoint marks while keeping edits and saved scenarios, send `{ "portfolioId": "<workspace ID>", "revision": "<current revision>" }` to `POST /v1/demo/refresh` after configuring a newer approved capture. The endpoint appends only new midpoint marks for existing open instruments. It preserves the owner's transactions and canonical instrument IDs. It leaves archived assumptions and previously saved scenarios pinned. Newly selected markets and reviewed resolutions are applied through a new workspace revision on reset.
