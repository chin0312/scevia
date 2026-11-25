# Scenario calculation and persistence

Scenario Lab v1 uses a portfolio-owned development workspace. Each scenario selects one reporting and funding asset. The funding key is an explicit venue/account bucket. Create a portfolio through the existing portfolio API if the workspace is empty. A scratch scenario needs no connected financial account.

## Baseline and lifecycle

Actual mode captures selected Phase 3 effective holdings, weighted-average basis, current eligible marks, available cash, pending entitlements, coverage and reviewed Phase 4 rules. Provider-reported positions remain outside effective inventory. Scratch mode starts empty with its own capital and outcome choices. Inputs are frozen under `weighted-average-scenario-v1` with the relevant Phase 4 revision identifiers and any selected public observations. The database stores normalized inputs and scenario assumptions. Re-evaluation runs against that saved snapshot without replaying the current portfolio.

All paths below are under `/v1/portfolios/{portfolioId}/scenarios`.

| Method and path | Operation |
| --- | --- |
| POST `/baseline` | Preview an actual or scratch source and obtain its baseline token |
| POST `/` | Save name, source and input. An optional baseline token guards against changes since preview |
| GET `/`, GET `/{id}` | List metadata or retrieve a saved scenario |
| PATCH `/{id}` | Rename or replace hypothetical input using the current revision |
| POST `/{id}/delete`, POST `/{id}/duplicate` | Delete using the current revision or copy with a new name |
| POST `/evaluate` | Calculate from an unsaved source or saved ID with optional temporary input overrides |
| POST `/{id}/rebase` | Preview actual scope at an explicit cutoff, then confirm with the returned token and revision. Supply a copy name to retain the original |
| POST `/compare` | Evaluate two to eight saved scenarios, with asset, baseline and assumptions compatibility |

Omit an operation to reset it. Use an explicit exit or zero target quantity to sell a held position. Replace hypothetical inputs as a batch with PATCH. Stale writes return 409. The system bounds saved scenarios to 50 per portfolio and caps construction and graph inputs. The same portfolio authorization and production fail-closed policy apply to every route.

## Construction and financial interpretation

- Each operation selects one bucket and outcome, with one operation per pair per batch. Buy notional excludes fees. Target weights use one cash-inclusive opening valuation plus explicit net funding, before modeled execution and fees. Target quantities derive from the selected reference mark and round down to 18 fractional places. Results expose actual post-execution weights and any underfunding.
- A batch nets hypothetical sales and purchases within the same bucket. Funds never flow between buckets. Pending entitlements contribute to an eligible value but are unavailable to trade. Unknown cash stays unknown unless the user declares assumed opening cash. The bridge retains the evidence-based opening value separately.
- Buy fees enter acquisition basis. A sale releases proportional weighted-average basis. Missing basis or fees leave affected amounts unavailable. The value bridge separates additions and withdrawals of capital, execution relative to reference, fees and assumed changes to marks. Realized gain appears separately from the change in portfolio value.
- Custom rate fees round up to eight decimal places. Fixed fees use their supplied decimal values. An explicit exclusion gives zero. For selected eligible public Polymarket outcomes the engine can freeze a market-specific USDC schedule and estimate the supported unit-exponent, taker-only formula with five-decimal rounding. Unknown schedules and unsupported fee formulas stay unavailable. [Polymarket fee methodology](https://docs.polymarket.com/trading/fees)
- The source can select stored catalog outcome UUIDs, explicit local outcomes, or up to six explicit provider outcome IDs via supported Polymarket links. The latter use the same restricted resolver as the public market API and require authorized provider access. Discovery and outcome choices remain at `/v1/market-data/search` and `/v1/market-data/resolve`. Latest public midpoints are retained with retrieval time. Values retrieved after the baseline cutoff cannot supply its historical mark. Local or user-assumed marks remain explicit.
- Allocation uses Phase 4 concentration calculations. Market and event views report the identified subset and unmapped marked value. Available portfolio values and ratios use the selected reporting asset. Comparisons return a capital-adjusted normalized change only when an eligible positive budget exists.
- Settlement runs the Phase 4 binary solver for baseline and hypothetical holdings. An independent conditional result applies local payout assumptions, additional logical constraints and explicit outcome selections. These inputs can restrict feasible outcomes and never write to reviewed rules. Unsupported holdings and components stay identified. A fixed payoff is a contractual result within the modeled scope.

## Limits

One asset is analyzed per scenario. Portfolios spanning assets can compare separate scenarios with an explicit incompatibility flag. The API has no FX, inter-account funding transfer, leverage, execution, historical backtest, or probability model. Provider-native outcomes require a reviewed catalog association for verified settlement. Event dates are schedule hints. Actual rebases retain saved public observations and capture current effective financial and reviewed catalog inputs. Provider authorization, live evidence validation and production workload testing remain separate work.
