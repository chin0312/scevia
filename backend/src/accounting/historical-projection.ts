import { prepareAccounting, replayAccounting } from './ledger.js'
import type { Evidence } from './model.js'

const referenceKey = ({ venue, account, asset, instrument }: Evidence['observation']) =>
  JSON.stringify([venue, account, asset, instrument])
const cashKey = ({ venue, account, asset }: Pick<Evidence['observation'], 'venue' | 'account' | 'asset'>) => JSON.stringify([venue, account, asset])
const time = (row: Evidence) => row.observation.timestamp

function prefix(rows: Evidence[], asOf: string) {
  let lower = 0
  let upper = rows.length
  while (lower < upper) {
    const middle = (lower + upper) >>> 1
    if (time(rows[middle]!) <= asOf) lower = middle + 1
    else upper = middle
  }
  return lower
}

// Ordinary references change valuation only. Keep unusual evidence in the
// canonical path so disputed marks and economic duplicates remain auditable.
export function prepareHistoricalProjection(evidence: Evidence[]) {
  const financial: Evidence[] = []
  const references = new Map<string, Evidence[]>()
  const markIds = new Set<string>()
  const seenIds = new Map<string, string>()
  const settlements = new Map<string, string>()
  const terminals = new Map<string, string>()
  let canonicalFrom: string | undefined
  const requireCanonical = (at: string) => {
    if (!canonicalFrom || at < canonicalFrom) canonicalFrom = at
  }
  const idKey = (item: Evidence['observation']) => JSON.stringify([item.venue, item.account, item.id])
  for (const row of evidence) {
    const item = row.observation
    if (item.type !== 'mark' || item.terminalMarketReference || item.simulatedResolution || item.price === null
      || row.unresolvedReason || !item.id) {
      financial.push(row)
      const bounds = item.terminalMarketReference ? terminals : item.type === 'settlement' ? settlements : null
      if (bounds) {
        const key = referenceKey(item)
        const first = bounds.get(key)
        if (!first || time(row) < first) bounds.set(key, time(row))
      }
      continue
    }
    markIds.add(idKey(item))
    const key = referenceKey(item)
    const records = references.get(key) ?? []
    records.push(row)
    references.set(key, records)
  }
  for (const row of evidence) {
    const key = idKey(row.observation)
    if (!markIds.has(key)) continue
    const previous = seenIds.get(key)
    if (previous) requireCanonical(previous > time(row) ? previous : time(row))
    if (!previous || time(row) < previous) seenIds.set(key, time(row))
  }
  financial.sort((a, b) => time(a).localeCompare(time(b)))
  for (const [key, rows] of references) {
    rows.sort((a, b) => time(a).localeCompare(time(b))
      || (a.observation.sequence ?? 0) - (b.observation.sequence ?? 0)
      || idKey(a.observation).localeCompare(idKey(b.observation)))
    const settled = settlements.get(key)
    const terminal = terminals.get(key)
    for (const [index, row] of rows.entries()) {
      if (terminal && time(row) === terminal) requireCanonical(time(row))
      if (settled && time(row) >= settled && (!terminal || time(row) < terminal)) requireCanonical(time(row))
      const previous = rows[index - 1]
      if (previous && time(previous) === time(row) && previous.observation.price !== row.observation.price) requireCanonical(time(row))
    }
  }
  const results = new Map<string, ReturnType<typeof replayAccounting>>()
  const prepared = new Map<number, ReturnType<typeof prepareAccounting>>()
  return (asOf: string) => {
    const cached = results.get(asOf)
    if (cached) return cached
    let result: ReturnType<typeof replayAccounting> | null = null
    if (!canonicalFrom || asOf < canonicalFrom) {
      const count = prefix(financial, asOf)
      let project = prepared.get(count)
      if (!project) {
        project = prepareAccounting(financial.slice(0, count), asOf)
        prepared.set(count, project)
      }
      const marks = [...references.values()].flatMap((rows) => {
        const latest = rows[prefix(rows, asOf) - 1]
        return latest ? [latest] : []
      })
      result = project(asOf, marks)
      if (result) {
        const scopes = new Set(result.cash.map(cashKey))
        if (marks.some(({ observation }) => !scopes.has(cashKey(observation)))) result = null
      }
    }
    const canonical = result ?? replayAccounting(evidence, asOf)
    results.set(asOf, canonical)
    return canonical
  }
}
