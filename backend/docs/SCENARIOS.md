# Scenario calculation and persistence

Scenario Lab v1 uses a portfolio-owned development workspace. Each scenario selects one reporting and funding asset. The funding key is an explicit venue/account bucket. Create a portfolio through the existing portfolio API if the workspace is empty. A scratch scenario needs no connected financial account.

## Baseline and lifecycle

Actual mode captures selected Phase 3 effective holdings, weighted-average basis, current eligible marks, available cash, pending entitlements, coverage and reviewed Phase 4 rules. Provider-reported positions remain outside effective inventory. Scratch mode starts empty with its own capital and outcome choices. Inputs are frozen under `weighted-average-scenario-v1` with the relevant Phase 4 revision identifiers and any selected public observations. The database stores normalized inputs and scenario assumptions. Re-evaluation runs against that saved snapshot without replaying the current portfolio.

All paths below are under `/v1/portfolios/{portfolioId}/scenarios`.

| Method and path | Operation |
| --- | --- |
| POST `/baseline` | Preview an actual or scratch source and obtain its baseline token |
| POST `/` | Save name, source and input. An optional baseline token saves the exact preview |
| GET `/`, GET `/{id}` | List metadata or retrieve a saved scenario |
| PATCH `/{id}` | Rename or replace hypothetical input using the current revision |
| POST `/{id}/delete`, POST `/{id}/duplicate` | Delete using the current revision or copy with a new name |
| POST `/evaluate` | Calculate from an unsaved source or saved ID with optional temporary input overrides |
| POST `/{id}/instruments` | Append selected instruments while preserving the original accounting inputs and reviewed rules |
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
- Settlement runs the Phase 4 binary solver for baseline and hypothetical holdings. An independent conditional result applies declared payout assumptions, additional logical constraints and explicit outcome selections. These inputs can restrict feasible outcomes and never write to reviewed rules. Unsupported holdings and components stay identified. A fixed payoff is a contractual result within the modeled scope.

## Limits

One asset is analyzed per scenario. Portfolios spanning assets can compare separate scenarios with an explicit incompatibility flag. The API has no FX, inter-account funding transfer, leverage, execution, historical backtest, or probability model. Provider-native outcomes require a reviewed catalog association for verified settlement. Event dates are schedule hints. Actual rebases retain saved public observations and capture current effective financial and reviewed catalog inputs. Provider authorization, live evidence validation and production workload testing remain separate work.

## Applicability, completeness and rebase review

- Conditional binary declarations accept selected public, unreviewed catalog and local instruments, including existing local holdings. The pair must use one denomination and agree with known market identity. Declarations cannot replace reviewed rules or claim the instruments of a reviewed group. Additional constraints and outcome selections apply only in the conditional view. Settlement coverage distinguishes an exact modeled subset from a complete selected scope.
- Canonical instrument metadata carries venue, denomination, lifecycle and native identity. A trusted public market and matching native outcome can alias the corresponding catalog instrument. Conflicting identifiers are not inferred to represent the same outcome. Provider instruments require a compatible bucket. Explicit mapped imports retain their existing scope, and abstract execution is labeled. Closed and resolved contracts require an explicitly abstract operation.
- An eligible instrument-level reference uses recent, scoped observations agreeing in value. Each existing holding retains its own frozen mark. A public selection can set `captureCurrentQuote` to freeze the retrieved public quote. A retrieval after the financial cutoff is recorded as a mixed current-quote assumption, with a retrieval timestamp. User mark overrides and execution prices remain separate. Save with the returned baseline token to persist the exact preview without refetching. Tokens are portfolio-bound, expire after 15 minutes and are held in the current server process with a bounded cache.
- A current or scratch scenario can add, edit or remove `input.hypotheticalBuckets` through revisioned input replacement. Use a distinct `hypothetical:` bucket ID, venue, account, reporting asset and starting capital. Hypothetical starting capital, further added capital and assumed missing cash are separate fields. Actual accounts remain untouched. Funding stays per bucket. `knownAdditionalCapitalRequired` sums known deficits even when the complete requirement is unavailable.
- Evaluation exposes independent availability for funding, quantities, valuation, basis, realized and unrealized P&L, fees and settlement. A bucket with unestablished inventory cannot size a new holding from assumed zero. Acquisition-basis rows identify holdings, while cash-inclusive event and market rows expose their denominator, cash, pending and unmapped exposure. Resolution exposure buckets use schedule hints and preserve unknown dates.
- A rebase preview returns differences in holdings, cash, instrument references and rules, plus indexed operation conflicts. Send a replacement `input` to preview the resolution and confirm with the same input, revision and token. A token binds the candidate baseline and reviewed input. The original can be retained through a rebased copy. Saved evaluation uses frozen public observations and performs no new market fetch.
- Comparison retains its original compatibility fields and separately reports financial baseline, account scope, valuation assumptions, capital budget, funding assumptions, fee methodology and settlement scope. Different selected markets can share a financial baseline. Absolute amounts retain their reporting asset, and normalized change uses the eligible capital budget of each scenario.
