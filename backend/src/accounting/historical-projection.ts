import { prepareAccounting, replayAccounting } from './ledger.js'
import type { Evidence } from './model.js'

const referenceKey = ({ venue, account, asset, instrument }: Evidence['observation']) =>
  JSON.stringify([venue, account, asset, instrument])

function prefix<T>(rows: T[], asOf: string, timestamp: (row: T) => string) {
  let lower = 0
  let upper = rows.length
  while (lower < upper) {
    const middle = (lower + upper) >>> 1
    if (timestamp(rows[middle]!) <= asOf) lower = middle + 1
    else upper = middle
  }
  return lower
}

// Replay's ordinary marks change valuation only. Terminal marks remain financial
// boundaries. Ambiguous selected marks use the canonical full replay.
export function prepareHistoricalProjection(evidence: Evidence[]) {
  const financial: Evidence[] = []
  const references = new Map<string, Evidence[]>()
  for (const row of evidence) {
    const item = row.observation
    if (item.type !== 'mark' || item.terminalMarketReference || item.simulatedResolution || item.price === null
      || row.unresolvedReason || !item.id) {
      financial.push(row)
      continue
    }
    const key = referenceKey(item)
    const records = references.get(key) ?? []
    records.push(row)
    references.set(key, records)
  }
  const time = (row: Evidence) => row.observation.timestamp
  const order = (a: Evidence, b: Evidence) => time(a).localeCompare(time(b))
  financial.sort(order)
  for (const rows of references.values()) rows.sort(order)
  const results = new Map<string, ReturnType<typeof replayAccounting>>()
  const prepared = new Map<number, ReturnType<typeof prepareAccounting>>()
  return (asOf: string) => {
    const cached = results.get(asOf)
    if (cached) return cached
    const count = prefix(financial, asOf, time)
    let project = prepared.get(count)
    if (!project) {
      project = prepareAccounting(financial.slice(0, count), asOf)
      prepared.set(count, project)
    }
    const marks: Evidence[] = []
    let conflict = false
    for (const rows of references.values()) {
      const index = prefix(rows, asOf, time) - 1
      const latest = rows[index]
      if (!latest) continue
      for (let prior = index - 1; prior >= 0 && time(rows[prior]!) === time(latest); prior--) {
        if (rows[prior]!.observation.price !== latest.observation.price) conflict = true
      }
      marks.push(latest)
    }
    const result = (!conflict ? project(asOf, marks) : null) ?? replayAccounting(evidence, asOf)
    results.set(asOf, result)
    return result
  }
}
