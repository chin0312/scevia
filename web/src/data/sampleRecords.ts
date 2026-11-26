/* Sample records for the portfolio workspace's record management (Transactions, Imports). Fictional and separate
   from the ledger behind Overview, Analytics and Risk: decisions here never change those figures. The two connected
   accounts are the sample portfolio's own accounts (same ids and names); Wallet B is a record-management example only.
   It exists to show how record management will work once the backend accounting API is connected. */
import type { Platform } from './types'

export type RecordType = 'deposit' | 'withdrawal' | 'buy' | 'sell' | 'fee' | 'settlement' | 'redemption'
export type RecordSource = 'api' | 'csv' | 'manual'
export type Outcome = 'YES' | 'NO'
export interface WorkspaceAccount {
  /** Stable identity, independent of the editable label. */
  id: string; venue: Platform; label: string
  /** How the account was added: connected (API / address tracking), imported (CSV only) or manual. */
  kind: 'connected' | 'imported' | 'manual'
  sources: RecordSource[]
  /** e.g. "public address tracking" — never a claim of ownership or authentication. */
  connection?: string
  /** Whether opening balances / full history are declared. Connection status is not accounting completeness. */
  openingDeclared: boolean
  /** True for the accounts behind the sample portfolio's figures (Overview, Analytics, Risk). */
  inAnalytics: boolean
  /** Latest observation from a connection (sample), when there is one. */
  lastObserved: string | null
}
export interface FinRecord {
  /** Record identity: `${batchId}#${row}` for imports, a generated id for manual and provider rows. */
  key: string; accountId: string; source: RecordSource
  /** Import batch (null for provider and manual records). */
  batchId: string | null
  /** Original source-record identity (provider id, or file + row). Stable across re-imports of the same file. */
  sourceRef: string
  time: string; type: RecordType
  /** Market title as recorded, and its catalog id when it was matched (null = a locally named instrument). */
  instrument: string | null; marketId: string | null; side: Outcome | null
  quantity: number | null; price: number | null
  /** Cash amount for deposits, withdrawals, standalone fees, redemptions. */
  amount: number | null
  /** null = fee not reported (unknown), 0 = known fee-free. */
  fee: number | null
}
export interface ImportBatch {
  id: string; file: string; accountId: string; mode: 'independent' | 'supplement'
  importedAt: string; rows: number
  /** A replaced batch stays in the history as superseded; its rows leave the active records. */
  status: 'active' | 'superseded'; replaces: string | null
}

export const SAMPLE_ACCOUNTS: WorkspaceAccount[] = [
  { id: 'pm-main', venue: 'pm', label: 'Wallet 0x7a…c2', kind: 'connected', sources: ['api', 'csv'], connection: 'public address tracking', openingDeclared: true, inAnalytics: true, lastObserved: '2026-11-24T08:00:00Z' },
  { id: 'pm-wallet-b', venue: 'pm', label: 'Wallet B', kind: 'imported', sources: ['csv'], openingDeclared: false, inAnalytics: false, lastObserved: null },
  { id: 'ks-main', venue: 'ks', label: 'Main account', kind: 'connected', sources: ['api'], connection: 'read-only API key', openingDeclared: true, inAnalytics: true, lastObserved: '2026-11-22T18:00:00Z' },
]

const r = (key: string, accountId: string, source: RecordSource, time: string, type: RecordType, x: Partial<FinRecord> = {}): FinRecord =>
  ({ key, accountId, source, batchId: x.batchId ?? null, sourceRef: x.sourceRef ?? key, time, type, instrument: null, marketId: null, side: null, quantity: null, price: null, amount: null, fee: null, ...x })

export const SAMPLE_RECORDS: FinRecord[] = [
  r('a-001', 'pm-main', 'api', '2026-08-03T14:02:00Z', 'deposit', { amount: 5000, fee: 0 }),
  r('a-002', 'pm-main', 'api', '2026-08-04T09:15:00Z', 'buy', { instrument: 'Bitcoin above $150k on Dec 31', marketId: 'pm-btc-150k', side: 'YES', quantity: 4000, price: 0.32, fee: 0 }),
  r('a-003', 'pm-main', 'api', '2026-08-19T16:40:00Z', 'buy', { instrument: 'Celtics win 2027 NBA Finals', marketId: 'pm-celtics-2027', side: 'YES', quantity: 3000, price: 0.2, fee: 0 }),
  r('a-004', 'pm-main', 'api', '2026-09-08T11:05:00Z', 'buy', { instrument: 'Government shutdown before Feb 1', marketId: 'pm-shutdown-feb1', side: 'YES', quantity: 2500, price: 0.36, fee: 0 }),
  r('a-005', 'pm-main', 'api', '2026-09-30T13:20:00Z', 'sell', { instrument: 'Celtics win 2027 NBA Finals', marketId: 'pm-celtics-2027', side: 'YES', quantity: 1000, price: 0.24, fee: 0 }),
  r('a-006', 'pm-main', 'api', '2026-10-14T10:00:00Z', 'buy', { instrument: 'Fed rate cut in December?', marketId: 'pm-fed-dec-cut', side: 'YES', quantity: 2000, price: 0.58, fee: 0 }),
  r('a-007', 'pm-main', 'api', '2026-10-14T10:00:00Z', 'buy', { instrument: 'Fed rate cut in December?', marketId: 'pm-fed-dec-cut', side: 'YES', quantity: 2000, price: 0.58, fee: 0 }),
  r('a-008', 'pm-main', 'api', '2026-11-02T18:30:00Z', 'settlement', { instrument: 'Incumbent wins Springfield mayoral election', marketId: 'pm-mayor', side: 'YES', quantity: 1500, price: 1, fee: 0 }),
  r('a-009', 'pm-main', 'api', '2026-11-03T08:12:00Z', 'redemption', { instrument: 'Incumbent wins Springfield mayoral election', marketId: 'pm-mayor', side: 'YES', amount: 1500, fee: 0 }),
  r('batch-1#1', 'pm-wallet-b', 'csv', '2026-07-01T00:00:00Z', 'deposit', { amount: 2500, fee: 0, batchId: 'batch-1', sourceRef: 'wallet-b-2026.csv#1' }),
  r('batch-1#2', 'pm-wallet-b', 'csv', '2026-07-02T12:00:00Z', 'buy', { instrument: 'Bitcoin above $150k on Dec 31', marketId: 'pm-btc-150k', side: 'YES', quantity: 3000, price: 0.36, fee: null, batchId: 'batch-1', sourceRef: 'wallet-b-2026.csv#2' }),
  r('batch-1#3', 'pm-wallet-b', 'csv', '2026-09-12T15:30:00Z', 'buy', { instrument: 'Chiefs win Super Bowl LXI', marketId: 'pm-chiefs-lxi', side: 'YES', quantity: 2000, price: 0.17, fee: null, batchId: 'batch-1', sourceRef: 'wallet-b-2026.csv#3' }),
  r('batch-1#4', 'pm-wallet-b', 'csv', '2026-10-20T09:45:00Z', 'sell', { instrument: 'Chiefs win Super Bowl LXI', marketId: 'pm-chiefs-lxi', side: 'YES', quantity: 500, price: 0.14, fee: null, batchId: 'batch-1', sourceRef: 'wallet-b-2026.csv#4' }),
  r('k-001', 'ks-main', 'api', '2026-08-10T10:00:00Z', 'deposit', { amount: 5000, fee: 0 }),
  r('k-002', 'ks-main', 'api', '2026-09-21T14:10:00Z', 'buy', { instrument: 'Fed cuts rates at Dec 2026 FOMC', marketId: 'ks-fed-dec-cut', side: 'YES', quantity: 2100, price: 0.56, fee: 8.23 }),
  r('k-003', 'ks-main', 'api', '2026-10-12T14:20:00Z', 'buy', { instrument: 'Fed cuts rates at Dec 2026 FOMC', marketId: 'ks-fed-dec-cut', side: 'YES', quantity: 1300, price: 0.59, fee: 5.37 }),
  r('k-004', 'ks-main', 'api', '2026-10-19T09:00:00Z', 'buy', { instrument: 'Nov CPI YoY above 3.0%', marketId: 'ks-cpi-nov-3', side: 'NO', quantity: 1500, price: 0.69, fee: 5.08 }),
  r('k-005', 'ks-main', 'api', '2026-10-28T09:30:00Z', 'buy', { instrument: 'Nov CPI YoY above 3.0%', marketId: 'ks-cpi-nov-3', side: 'NO', quantity: 900, price: 0.72, fee: 3.39 }),
  r('k-006', 'ks-main', 'api', '2026-11-04T16:00:00Z', 'fee', { amount: 1.5 }),
  r('k-007', 'ks-main', 'api', '2026-11-09T11:11:00Z', 'buy', { instrument: 'ETH ETFs net inflows > $1B in Nov', marketId: 'ks-eth-etf-nov', side: 'YES', quantity: 1750, price: 0.43, fee: 7.5 }),
  r('k-008', 'ks-main', 'api', '2026-11-12T08:00:00Z', 'withdrawal', { amount: 750, fee: 0 }),
]
export const SAMPLE_BATCHES: ImportBatch[] = [
  { id: 'batch-1', file: 'wallet-b-2026.csv', accountId: 'pm-wallet-b', mode: 'independent', importedAt: '2026-11-20T10:00:00Z', rows: 4, status: 'active', replaces: null },
]

/** Sample CSV files offered by the import flow (nothing is read from the user's disk in this build). */
export interface SampleFile { name: string; about: string; rows: Omit<FinRecord, 'key' | 'accountId' | 'source' | 'batchId' | 'sourceRef'>[] }
export const SAMPLE_FILES: SampleFile[] = [
  {
    name: 'wallet-a-history-2026-h1.csv', about: 'Older trades for Wallet 0x7a…c2, from before the connection started. Two rows match records the connection already has.',
    rows: [
      { time: '2026-08-03T14:02:00Z', type: 'deposit', instrument: null, marketId: null, side: null, quantity: null, price: null, amount: 5000, fee: 0 },
      { time: '2026-08-04T09:15:00Z', type: 'buy', instrument: 'Bitcoin above $150k on Dec 31', marketId: 'pm-btc-150k', side: 'YES', quantity: 4000, price: 0.32, amount: null, fee: 0 },
      { time: '2026-05-11T10:00:00Z', type: 'deposit', instrument: null, marketId: null, side: null, quantity: null, price: null, amount: 1500, fee: 0 },
      { time: '2026-05-12T12:30:00Z', type: 'buy', instrument: 'US recession declared in 2027', marketId: 'pm-recession-2027', side: 'NO', quantity: 1200, price: 0.78, amount: null, fee: 0 },
      { time: '2026-06-02T09:00:00Z', type: 'sell', instrument: 'US recession declared in 2027', marketId: 'pm-recession-2027', side: 'NO', quantity: 400, price: 0.8, amount: null, fee: null },
    ],
  },
  {
    name: 'wallet-c-export.csv', about: 'Another wallet’s history. Import it as its own account. Nothing in it is matched to other accounts.',
    rows: [
      { time: '2026-06-15T10:00:00Z', type: 'deposit', instrument: null, marketId: null, side: null, quantity: null, price: null, amount: 1000, fee: 0 },
      { time: '2026-06-16T11:20:00Z', type: 'buy', instrument: 'Solana above $500 on Dec 31', marketId: 'pm-sol-500', side: 'YES', quantity: 2000, price: 0.1, amount: null, fee: 0 },
      { time: '2026-07-30T17:45:00Z', type: 'buy', instrument: 'Lakers win 2027 Finals', marketId: 'pm-lakers-2027', side: 'YES', quantity: 1500, price: 0.08, amount: null, fee: null },
    ],
  },
]
