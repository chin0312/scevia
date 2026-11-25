import { Decimal } from 'decimal.js'
import { z } from 'zod'

const types = ['opening_cash', 'opening_position', 'buy', 'sell', 'deposit', 'withdrawal', 'fee', 'rebate', 'reward', 'settlement', 'redemption', 'mark', 'split', 'merge'] as const
const columns = ['venue', 'account', 'id', 'timestamp', 'sequence', 'type', 'instrument', 'asset', 'quantity', 'price', 'amount', 'fee', 'fee_asset'] as const
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/
const decimal = /^-?\d{1,20}(?:\.\d{1,18})?$/
const time = z.iso.datetime({ offset: true })

export interface FinancialObservation {
  venue: string
  account: string
  id: string | null
  timestamp: string
  sequence: number | null
  type: typeof types[number]
  instrument: string | null
  asset: string
  quantity: string | null
  price: string | null
  amount: string | null
  fee: string | null
  feeAsset: string | null
}

export function parseFinancialCsv(input: string) {
  const table = csvRows(input.replace(/^\uFEFF/, ''))
  const header = table.shift()
  if (!header || header.join(',') !== columns.join(',')) throw new Error('invalid_csv_header')
  if (table.length === 0) throw new Error('empty_csv')
  const rows: FinancialObservation[] = []
  const issues: Array<{ row: number; code: string }> = []
  for (const [index, cells] of table.entries()) {
    try { rows.push(normalize(cells)) }
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
    if (cell.length > 200 || row.length > columns.length || rows.length > 2001) throw new Error('csv_limit_exceeded')
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
  if (inventory && (q === null || q === '0')) throw new Error('positive_quantity_required')
  if ((trade || kind === 'mark' || kind === 'settlement') && (p === null || new Decimal(p).gt(1))) throw new Error('invalid_outcome_price')
  if (!inventory && kind !== 'mark' && kind !== 'split' && kind !== 'merge' && a === null) throw new Error('amount_required')
  if (kind === 'redemption' && a === null) throw new Error('amount_required')
  if (!inventory && q !== null) throw new Error('unexpected_quantity')
  if (!(trade || kind === 'mark' || kind === 'settlement') && p !== null) throw new Error('unexpected_price')
  if ((trade || kind === 'settlement' || kind === 'mark') && a !== null) throw new Error('unexpected_amount')
  if (!(inventory || kind === 'mark' || kind === 'split' || kind === 'merge') && instrument) throw new Error('unexpected_instrument')
  if (feeAsset && f === null) throw new Error('fee_amount_required')
  if (!trade && f !== null) throw new Error('use_separate_fee_event')
  return { venue: venue!, account: account!, id: id || null, timestamp: new Date(timestamp!).toISOString(),
    sequence: sequence ? Number(sequence) : null, type: kind, instrument: instrument || null, asset: asset!,
    quantity: q, price: p, amount: a, fee: f, feeAsset: feeAsset || null }
}
