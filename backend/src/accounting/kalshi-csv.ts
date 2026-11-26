import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { csvRows, parseFinancialCsv } from './csv.js'

const column = z.string().min(1).max(100)
export const kalshiCsvMapping = z.object({
  format: z.literal('kalshi_activity'), account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/),
  activity: z.enum(['fill', 'deposit', 'withdrawal', 'fee', 'rebate', 'reward']),
  units: z.enum(['dollars', 'cents']),
  columns: z.object({ id: column, timestamp: column, ticker: column.optional(), side: column.optional(), action: column.optional(),
    quantity: column.optional(), price: column.optional(), amount: column.optional(), fee: column.optional() }).strict(),
}).strict()
export type KalshiCsvMapping = z.infer<typeof kalshiCsvMapping>
const quote = (input: string) => '"' + input.replaceAll('"', '""') + '"'
const decimal = /^\d{1,20}(?:\.\d{1,18})?$/

export function parseMappedKalshiCsv(text: string, mapping: KalshiCsvMapping) {
  const table = csvRows(text.replace(/^\uFEFF/, ''))
  const header = table.shift()
  if (!header || new Set(header).size !== header.length || !table.length) throw new Error('invalid_mapped_csv_header')
  const selected = mapping.columns
  const fill = mapping.activity === 'fill'
  if (Object.values(selected).some((name) => name !== undefined && !header.includes(name))
    || (fill ? !selected.ticker || !selected.side || !selected.action || !selected.quantity || !selected.price : !selected.amount)) {
    throw new Error('kalshi_csv_mapping_incomplete')
  }
  const rows: string[] = []
  const failures: Array<{ row: number; code: string }> = []
  const originalRows: number[] = []
  for (const [index, cells] of table.entries()) {
    const at = (name?: string) => name === undefined ? '' : cells[header.indexOf(name)]?.trim() ?? ''
    const money = (value: string) => {
      if (!value) return ''
      if (!decimal.test(value)) throw new Error('invalid_kalshi_decimal')
      return new Decimal(value).div(mapping.units === 'cents' ? 100 : 1).toFixed()
    }
    try {
      if (cells.length !== header.length) throw new Error('invalid_column_count')
      const id = at(selected.id)
      const ticker = at(selected.ticker).toUpperCase()
      const side = at(selected.side).toLowerCase()
      const action = at(selected.action).toLowerCase()
      if (!id) throw new Error('kalshi_native_id_required')
      if (fill && (!/^[A-Z0-9][A-Z0-9_-]{0,127}$/.test(ticker) || !['yes', 'no'].includes(side) || !['buy', 'sell'].includes(action))) {
        throw new Error('kalshi_fill_mapping_invalid')
      }
      rows.push(['kalshi', mapping.account, id, at(selected.timestamp), '', fill ? action : mapping.activity,
        fill ? ticker + ':' + side : '', 'USD', fill ? at(selected.quantity) : '', fill ? money(at(selected.price)) : '',
        fill ? '' : money(at(selected.amount)), fill ? money(at(selected.fee)) : '', ''].map(quote).join(','))
      originalRows.push(index + 2)
    } catch (error) { failures.push({ row: index + 2, code: (error as Error).message }) }
  }
  if (!rows.length) return { rows: [], issues: failures, totalRows: table.length }
  const parsed = parseFinancialCsv(['venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset', ...rows].join('\n'))
  return { rows: parsed.rows, issues: [...failures, ...parsed.issues.map((issue) => ({ ...issue, row: originalRows[issue.row - 2]! }))]
    .sort((a, b) => a.row - b.row), totalRows: table.length }
}
