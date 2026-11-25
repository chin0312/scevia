import { createHash } from 'node:crypto'
import type { Evidence, PortfolioDecision } from './model.js'

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

export function applyDecisions(evidence: Evidence[], decisions: Map<string, PortfolioDecision | null>) {
  const known = new Map(evidence.map((item) => [recordKey(item), item]))
  const records = evidence.map((item) => {
    const key = recordKey(item)
    const revision = evidenceRevision(item)
    const decision = decisions.get(key) ?? null
    const revisionChanged = decision !== null && decision.evidenceRevision !== revision
    const target = decision?.duplicateOf ? known.get(decision.duplicateOf) : undefined
    const selected = decision?.action === 'exclude' || decision?.action === 'duplicate'
    let effective: Evidence | null = item
    if (selected) effective = null
    else if (decision && revisionChanged) effective = { ...item, unresolvedReason: 'user_decision_evidence_changed' }
    else if (decision?.action === 'include' || decision?.action === 'distinct' || decision?.action === 'correct') {
      const observation = decision.correction ?? item.observation
      effective = {
        ...item,
        observation: {
          ...observation,
          id: decision.action === 'distinct' || item.unresolvedReason || !observation.id ? 'local:' + key : observation.id,
        },
        authority: 'user_accepted',
      }
      delete effective.unresolvedReason
    }
    return {
      key, revision, acquisition: item.acquisition ?? ('batchId' in item ? 'import' : 'provider'), decision, revisionChanged, original: item.originalObservation ?? item.observation, originalReason: item.unresolvedReason ?? null, effective,
      inclusion: selected ? 'excluded' : effective?.unresolvedReason || !effective?.observation.id ? 'unresolved' : 'included',
      source: 'batchId' in item ? { kind: 'import', batchId: item.batchId, row: item.row } :
        { kind: 'provider', providerAccountId: item.providerAccountId, sourceRecordId: item.sourceRecordId },
      ...(decision?.duplicateOf ? { duplicateLinkStatus: !target || ['duplicate', 'exclude'].includes(decisions.get(decision.duplicateOf)?.action ?? '')
        ? 'target_unavailable' : decision.duplicateRevision !== evidenceRevision(target) ? 'target_revised' : 'selected' } : {}),
      ...(target ? { duplicateTarget: recordKey(target) } : {}),
    }
  })
  return { records, evidence: records.flatMap((record) => record.effective ? [record.effective] : []) }
}

export function potentialOverlaps(observations: Evidence[]) {
  const groups = new Map<string, Evidence[]>()
  for (const item of observations) {
    const { type, account, venue, timestamp, instrument, asset, quantity, price, amount } = item.observation
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
