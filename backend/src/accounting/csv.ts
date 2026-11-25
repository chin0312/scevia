import { Decimal } from 'decimal.js'
import { z } from 'zod'

import { financialEventTypes as types, type FinancialObservation } from './model.js'
const columns = ['venue', 'account', 'id', 'timestamp', 'sequence', 'type', 'instrument', 'asset', 'quantity', 'price', 'amount', 'fee', 'fee_asset'] as const
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/
const decimal = /^-?\d{1,20}(?:\.\d{1,18})?$/
const time = z.iso.datetime({ offset: true })


export function parseFinancialCsv(input: string) {
  const table = csvRows(input.replace(/^\uFEFF/, ''))
  const header = table.shift()
  const allowed: readonly string[] = [...columns, 'entitlement_id', 'counter_instrument', 'primary_basis_fraction', 'related_event_id', 'fee_timing', 'coverage_through']
  if (!header || new Set(header).size !== header.length || header.some((name) => !allowed.includes(name))
    || columns.some((name) => !header.includes(name))) throw new Error('invalid_csv_header')
  if (table.length === 0) throw new Error('empty_csv')
  const rows: FinancialObservation[] = []
  const issues: Array<{ row: number; code: string }> = []
  for (const [index, cells] of table.entries()) {
    try {
      if (cells.length !== header.length) throw new Error('invalid_column_count')
      const row = normalize(columns.map((name) => cells[header.indexOf(name)]!))
      const entitlement = cells[header.indexOf('entitlement_id')]?.trim()
      if (entitlement) {
        if (row.type !== 'redemption' || !identifier.test(entitlement)) throw new Error('invalid_entitlement_reference')
        row.entitlementId = entitlement
      }
      const related = cells[header.indexOf('related_event_id')]?.trim()
      if (related) {
        if (!['fee', 'rebate'].includes(row.type) || !identifier.test(related)) throw new Error('invalid_fee_event_reference')
        row.relatedEventId = related
      }
      const coverage = cells[header.indexOf('coverage_through')]?.trim()
      if (row.type === 'history_complete') {
        if (!coverage || !time.safeParse(coverage).success || /\.\d{4}/.test(coverage)
          || new Date(coverage).toISOString() < row.timestamp) throw new Error('invalid_history_coverage')
        row.coveredThrough = new Date(coverage).toISOString()
      } else if (coverage) throw new Error('unexpected_history_coverage')
      const timing = cells[header.indexOf('fee_timing')]?.trim()
      if (timing) {
        if (!row.relatedEventId || (timing !== 'execution_evidence' && timing !== 'separate_cash_flow')) throw new Error('invalid_fee_timing')
        row.feeTiming = timing
      }
      const counter = cells[header.indexOf('counter_instrument')]?.trim()
      const fraction = cells[header.indexOf('primary_basis_fraction')]?.trim()
      if (counter || fraction) {
        if (!['split', 'merge'].includes(row.type) || !counter || !identifier.test(counter)
          || !row.instrument || counter === row.instrument || !row.quantity || row.quantity === '0'
          || row.amount !== row.quantity || !fraction || !decimal.test(fraction)
          || new Decimal(fraction).lt(0) || new Decimal(fraction).gt(1)) throw new Error('invalid_complete_set')
        row.completeSet = { counterInstrument: counter, primaryBasisFraction: new Decimal(fraction).toFixed() }
      }
      rows.push(row)
    }
    catch (error) { issues.push({ row: index + 2, code: (error as Error).message }) }
  }
  return { rows, issues, totalRows: table.length }
}

function csvRows(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let closed = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quoted) {
      if (char !== '"') cell += char
      else if (input[index + 1] === '"') { cell += '"'; index += 1 }
      else { quoted = false; closed = true }
    } else if (char === ',' || char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] !== '\n') throw new Error('invalid_csv_line_ending')
      if (char === '\r') continue
      row.push(cell)
      cell = ''
      closed = false
      if (char === '\n') { rows.push(row); row = [] }
    } else if (char === '"' && !closed && cell.length === 0) quoted = true
    else if (closed || char === '"') throw new Error('invalid_csv_quote')
    else cell += char
    if (cell.length > 200 || row.length > columns.length + 6 || rows.length > 2001) throw new Error('csv_limit_exceeded')
  }
  if (quoted) throw new Error('invalid_csv_quote')
  if (row.length || cell.length || closed) rows.push([...row, cell])
  if (rows.length > 2001) throw new Error('csv_limit_exceeded')
  return rows
}

function normalize(cells: string[]): FinancialObservation {
  if (cells.length !== columns.length) throw new Error('invalid_column_count')
  const [venue, account, id, timestamp, sequence, type, instrument, asset, quantity, price, amount, fee, feeAsset] = cells.map((cell) => cell.trim()) as [string, string, string, string, string, string, string, string, string, string, string, string, string]
  if (![venue, account, asset].every((value) => identifier.test(value!))
    || [id, instrument, feeAsset].some((value) => value && !identifier.test(value))) throw new Error('invalid_identifier')
  if (!time.safeParse(timestamp).success || /\.\d{4}/.test(timestamp!) || (sequence && !/^\d{1,9}$/.test(sequence))) throw new Error('invalid_event_order')
  const kind = types.find((candidate) => candidate === type)
  if (!kind) throw new Error('unsupported_event_type')
  const values = [quantity, price, amount, fee].map((value) => {
    if (!value) return null
    if (!decimal.test(value) || new Decimal(value).isNegative()) throw new Error('invalid_decimal')
    return new Decimal(value).toFixed()
  })
  const [q, p, a, f] = values as [string | null, string | null, string | null, string | null]
  const trade = kind === 'buy' || kind === 'sell'
  const inventory = trade || kind === 'opening_position' || kind === 'settlement' || kind === 'redemption'
  if ((inventory || kind === 'mark') && !instrument) throw new Error('instrument_required')
  if (inventory && (q === null || (q === '0' && kind !== 'opening_position'))) throw new Error('positive_quantity_required')
  if ((trade || kind === 'mark' || kind === 'settlement') && (p === null || (kind !== 'settlement' && new Decimal(p).gt(1)))) throw new Error('invalid_outcome_price')
  if (!inventory && kind !== 'mark' && kind !== 'split' && kind !== 'merge' && kind !== 'opening_inventory' && kind !== 'history_complete' && a === null) throw new Error('amount_required')
  if ((kind === 'opening_inventory' || kind === 'history_complete') && a !== null) throw new Error('unexpected_amount')
  if (kind === 'opening_position' && q === '0' && a !== null && a !== '0') throw new Error('invalid_zero_opening_basis')
  if (kind === 'redemption' && a === null) throw new Error('amount_required')
  if (!inventory && kind !== 'split' && kind !== 'merge' && q !== null) throw new Error('unexpected_quantity')
  if (!(trade || kind === 'mark' || kind === 'settlement') && p !== null) throw new Error('unexpected_price')
  if ((trade || kind === 'settlement' || kind === 'mark') && a !== null) throw new Error('unexpected_amount')
  if (!(inventory || kind === 'mark' || kind === 'split' || kind === 'merge') && instrument) throw new Error('unexpected_instrument')
  if (feeAsset && f === null) throw new Error('fee_amount_required')
  if (!trade && f !== null) throw new Error('use_separate_fee_event')
  return { venue: venue!, account: account!, id: id || null, timestamp: new Date(timestamp!).toISOString(),
    sequence: sequence ? Number(sequence) : null, type: kind, instrument: instrument || null, asset: asset!,
    quantity: q, price: p, amount: a, fee: f, feeAsset: feeAsset || null }
}

export function normalizeManualEvent(input: Record<string, unknown>): FinancialObservation {
  const names = ['venue', 'account', 'id', 'timestamp', 'sequence', 'type', 'instrument', 'asset', 'quantity', 'price', 'amount', 'fee', 'feeAsset']
  if (Object.keys(input).some((key) => !names.includes(key))) throw new Error('unexpected_financial_field')
  const row = normalize(names.map((key) => {
    const value = input[key]
    if (value === undefined || value === null) return ''
    if (key === 'sequence' && typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    if (typeof value !== 'string' || value.length > 200) throw new Error('invalid_financial_field')
    return value
  }))
  if (row.type === 'history_complete') throw new Error('declare_history_via_import')
  return row
}
