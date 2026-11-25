import { createHash } from 'node:crypto'
import type { ComposedDecision, Evidence, PortfolioDecision } from './model.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
  return value
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const recordKey = (evidence: Evidence) => 'batchId' in evidence
  ? 'import:' + evidence.batchId + ':' + evidence.row : 'provider:' + evidence.sourceRecordId
export const evidenceRevision = (evidence: Evidence) => digest([
  'payloadSha256' in evidence ? evidence.payloadSha256 : null, evidence.observation, evidence.unresolvedReason ?? null,
])

export function compose(decision: PortfolioDecision | null | undefined): ComposedDecision {
  if (!decision) return {}
  if (!('action' in decision)) return { ...decision }
  switch (decision.action) {
    case 'exclude': return { membership: 'excluded', membershipRevision: decision.evidenceRevision }
    case 'duplicate': return decision.duplicateOf && decision.duplicateRevision
      ? { duplicate: { target: decision.duplicateOf, revision: decision.duplicateRevision, sourceRevision: decision.evidenceRevision } } : {}
    case 'correct': return decision.correction ? {
      financial: { values: decision.correction, revision: decision.evidenceRevision },
    } : {}
    default: return { identity: { mode: decision.action, revision: decision.evidenceRevision } }
  }
}

export function applyDecisions(evidence: Evidence[], decisions: Map<string, PortfolioDecision | null>) {
  const records = evidence.map((item) => {
    const key = recordKey(item)
    const revision = evidenceRevision(item)
    const saved = decisions.get(key) ?? null
    const decision = compose(saved)
    const excluded = decision.membership === 'excluded'
    const revisionChanged = ('payloadSha256' in item && saved !== null && 'action' in saved && saved.evidenceRevision !== revision)
      || !!((decision.membershipRevision && decision.membershipRevision !== revision) || (decision.financial && decision.financial.revision !== revision)
      || (decision.identity && decision.identity.revision !== revision)
      || (decision.duplicate?.sourceRevision && decision.duplicate.sourceRevision !== revision))
    let effective: Evidence | null = item
    if (excluded) effective = null
    else if ((decision.financial && decision.financial.revision !== revision) || (decision.identity && decision.identity.revision !== revision)) {
      effective = { ...item, unresolvedReason: 'user_decision_evidence_changed' }
    } else if (decision.identity || decision.financial) {
      const observation = decision.financial?.values ?? item.observation
      effective = { ...item, observation: { ...observation,
        id: decision.identity?.mode === 'distinct' || item.unresolvedReason || !observation.id ? 'local:' + key : observation.id,
      }, authority: 'user_accepted' }
      delete effective.unresolvedReason
    }
    return { key, revision, acquisition: item.acquisition ?? ('batchId' in item ? 'import' : 'provider'),
      decision: saved, dimensions: decision, linkedSourceRecordId: item.linkedSourceRecordId ?? null, revisionChanged, original: item.originalObservation ?? item.observation,
      providerActivity: item.providerActivity ?? null, instrumentMetadata: item.instrumentMetadata ?? null, originalReason: item.unresolvedReason ?? null, effective, effectiveRevision: effective ? evidenceRevision(effective) : null,
      inclusion: excluded ? 'excluded' : effective?.unresolvedReason || !effective?.observation.id ? 'unresolved' : 'included',
      duplicateLinkStatus: null as string | null, duplicateTarget: decision.duplicate?.target ?? null, item,
      source: 'batchId' in item ? { kind: 'import', batchId: item.batchId, row: item.row } :
        { kind: 'provider', providerAccountId: item.providerAccountId, sourceRecordId: item.sourceRecordId },
    }
  })
  const known = new Map(records.map((record) => [record.key, record]))
  for (const record of records) {
    const duplicate = record.dimensions.duplicate
    if (!duplicate) continue
    const target = known.get(duplicate.target)
    const targetRevision = target?.effectiveRevision
    const valid = target?.inclusion === 'included' && !target.dimensions.duplicate && target.key !== record.key
      && targetRevision === duplicate.revision && !record.revisionChanged
    record.duplicateLinkStatus = valid ? 'selected' : targetRevision && targetRevision !== duplicate.revision ? 'target_revised' : 'review_required'
    if (record.dimensions.membership === 'excluded') continue
    record.effective = valid ? null : { ...record.item, unresolvedReason: 'duplicate_relationship_requires_review' }
    record.inclusion = valid ? 'excluded' : 'unresolved'
  }
  return { records: records.map(({ item: _item, ...record }) => record),
    evidence: records.flatMap((record) => record.effective ? [record.effective] : []) }
}

export function potentialOverlaps(observations: Evidence[]) {
  const groups = new Map<string, Evidence[]>()
  for (const item of observations) {
    const { account, venue, timestamp, instrument, asset, quantity, price, amount } = item.observation
    const type = item.providerActivity?.side?.toLowerCase() ?? item.observation.type
    if (!['buy', 'sell', 'deposit', 'withdrawal', 'fee', 'rebate', 'redemption', 'settlement', 'reward', 'split', 'merge'].includes(type)) continue
    const key = JSON.stringify([type, venue, account, timestamp, instrument, asset, quantity, price, amount])
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const matches = new Map<string, { count: number; examples: string[] }>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const keys = group.map(recordKey)
    for (const key of keys) matches.set(key, { count: keys.length - 1, examples: keys.slice(0, 6).filter((other) => other !== key).slice(0, 5) })
  }
  return matches
}

export function replacementDecisions(
  prior: Evidence[], next: Evidence[], active: Evidence[], decisions: Map<string, PortfolioDecision | null>,
) {
  const identity = (item: Evidence) => {
    const row = item.originalObservation ?? item.observation
    return row.id ? JSON.stringify([row.venue, row.account, row.type, row.id]) : null
  }
  const index = (items: Evidence[]) => {
    const groups = new Map<string, Evidence[]>()
    for (const item of items) {
      const id = identity(item)
      if (!id) continue
      const group = groups.get(id) ?? []
      group.push(item)
      groups.set(id, group)
    }
    return groups
  }
  const previous = index(prior)
  const incoming = index(next)
  const matches = new Map<string, Evidence>()
  for (const [id, items] of previous) {
    const counterpart = incoming.get(id)
    if (items.length === 1 && counterpart?.length === 1) matches.set(recordKey(items[0]!), counterpart[0]!)
  }
  const changes = new Map<string, PortfolioDecision>()
  const report: Array<{ from: string; to: string | null; status: string }> = []
  for (const item of prior) {
    const from = recordKey(item)
    const saved = decisions.get(from)
    if (!saved) continue
    const replacement = matches.get(from)
    if (!replacement) { report.push({ from, to: null, status: 'unmatched_or_ambiguous' }); continue }
    const to = recordKey(replacement)
    const dimensions = compose(saved)
    const currentRevision = evidenceRevision(replacement)
    const unchanged = evidenceRevision(item) === currentRevision
    const incorporated = dimensions.financial && digest(dimensions.financial.values) === digest(replacement.observation)
    if (incorporated) delete dimensions.financial
    if (dimensions.duplicate && matches.has(dimensions.duplicate.target)) {
      dimensions.duplicate = { ...dimensions.duplicate, target: recordKey(matches.get(dimensions.duplicate.target)!) }
    }
    if (Object.keys(dimensions).length) changes.set(to, dimensions)
    report.push({ from, to, status: incorporated ? 'correction_incorporated' : unchanged ? 'carried' : 'requires_review' })
  }
  for (const item of active) {
    const key = recordKey(item)
    const dimensions = compose(decisions.get(key))
    const target = dimensions.duplicate && matches.get(dimensions.duplicate.target)
    if (!dimensions.duplicate || !target) continue
    dimensions.duplicate = { ...dimensions.duplicate, target: recordKey(target) }
    changes.set(key, dimensions)
    report.push({ from: key, to: key, status: 'duplicate_target_remapped' })
  }
  return { changes, report }
}
