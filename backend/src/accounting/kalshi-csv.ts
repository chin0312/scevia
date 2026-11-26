import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { csvRows, parseFinancialCsv } from './csv.js'

const moneyUnit = z.enum(['dollars', 'cents'])
const column = z.string().min(1).max(100)
export const kalshiCsvMapping = z.object({
  format: z.literal('kalshi_activity'), account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/),
  activity: z.enum(['fill', 'deposit', 'withdrawal', 'fee', 'rebate', 'reward', 'settlement', 'redemption']),
  units: moneyUnit,
  fieldUnits: z.object({ price: moneyUnit.optional(), amount: moneyUnit.optional(), fee: moneyUnit.optional() }).strict().optional(),
  columns: z.object({ id: column, timestamp: column, ticker: column.optional(), side: column.optional(), action: column.optional(),
    quantity: column.optional(), price: column.optional(), amount: column.optional(), fee: column.optional(), status: column.optional(), sequence: column.optional(), entitlement: column.optional() }).strict(),
}).strict()
export type KalshiCsvMapping = z.infer<typeof kalshiCsvMapping>
const quote = (input: string) => '"' + input.replaceAll('"', '""') + '"'
const decimal = /^\d{1,20}(?:\.\d{1,18})?$/

export function parseMappedKalshiCsv(text: string, mapping: KalshiCsvMapping) {
  const table = csvRows(text.replace(/^\uFEFF/, ''))
  const header = table.shift()
  if (!header || new Set(header).size !== header.length || !table.length) throw new Error('invalid_mapped_csv_header')
  const selected = mapping.columns
  const assigned = Object.values(selected).filter((name) => name !== undefined)
  if (new Set(assigned).size !== assigned.length) throw new Error('kalshi_csv_mapping_duplicate_column')
  const fill = mapping.activity === 'fill'
  const settlement = mapping.activity === 'settlement'
  const redemption = mapping.activity === 'redemption'
  const instrumentRequired = fill || settlement || redemption
  const requiresPrice = fill || settlement
  if (Object.values(selected).some((name) => name !== undefined && !header.includes(name))
    || (instrumentRequired && (!selected.ticker || !selected.side || !selected.quantity))
    || (requiresPrice && !selected.price) || (fill && !selected.action)
    || (!requiresPrice && !selected.amount) || (redemption && !selected.entitlement)) {
    throw new Error('kalshi_csv_mapping_incomplete')
  }
  const rows: string[] = []
  const failures: Array<{ row: number; code: string }> = []
  const originalRows: number[] = []
  for (const [index, cells] of table.entries()) {
    const at = (name?: string) => name === undefined ? '' : cells[header.indexOf(name)]?.trim() ?? ''
    const money = (field: 'price' | 'amount' | 'fee') => {
      const value = at(selected[field])
      if (!value) return ''
      if (!decimal.test(value)) throw new Error('invalid_kalshi_decimal')
      return new Decimal(value).div((mapping.fieldUnits?.[field] ?? mapping.units) === 'cents' ? 100 : 1).toFixed()
    }
    try {
      if (cells.length !== header.length) throw new Error('invalid_column_count')
      const id = at(selected.id)
      const ticker = at(selected.ticker).toUpperCase()
      const side = at(selected.side).toLowerCase()
      const action = at(selected.action).toLowerCase()
      if (!id) throw new Error('kalshi_native_id_required')
      if ((instrumentRequired && (!/^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(ticker) || !['yes', 'no'].includes(side)))
        || (fill && !['buy', 'sell'].includes(action))) throw new Error('kalshi_instrument_mapping_invalid')
      if (selected.status && !['applied', 'finalized'].includes(at(selected.status).toLowerCase())) {
        throw new Error('kalshi_activity_not_finalized')
      }
      const price = requiresPrice ? money('price') : ''
      if (settlement && price !== '0' && price !== '1') throw new Error('kalshi_standard_payout_required')
      if (!fill && selected.fee && at(selected.fee) && money('fee') !== '0') throw new Error('use_separate_fee_event')
      rows.push(['kalshi', mapping.account, id, at(selected.timestamp), at(selected.sequence), fill ? action : mapping.activity,
        instrumentRequired ? ticker + ':' + side : '', 'USD', instrumentRequired ? at(selected.quantity) : '', price,
        requiresPrice ? '' : money('amount'), fill ? money('fee') : '', '', redemption ? at(selected.entitlement) : ''].map(quote).join(','))
      originalRows.push(index + 2)
    } catch (error) { failures.push({ row: index + 2, code: (error as Error).message }) }
  }
  if (!rows.length) return { rows: [], issues: failures, totalRows: table.length }
  const parsed = parseFinancialCsv(['venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset,entitlement_id', ...rows].join('\n'))
  return { rows: parsed.rows, issues: [...failures, ...parsed.issues.map((issue) => ({ ...issue, row: originalRows[issue.row - 2]! }))]
    .sort((a, b) => a.row - b.row), totalRows: table.length }
}
