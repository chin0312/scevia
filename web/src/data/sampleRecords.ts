/* Sample records workspace for "Accounts & records". Fictional, isolated from the sample portfolio: decisions made
   here never change Overview, Analytics, Risk or Scenario Lab figures. It exists to show how account-level record
   management will work once the backend (Phase 3 accounting API) is connected. */
import type { Platform } from './types'

export type RecordType = 'deposit' | 'withdrawal' | 'buy' | 'sell' | 'fee' | 'settlement' | 'redemption'
export type RecordSource = 'api' | 'csv' | 'manual'
export interface WorkspaceAccount {
  id: string; venue: Platform; label: string
  kind: 'connected' | 'imported' | 'manual'
  /** How this account's records arrive. Connected accounts can be supplemented by CSV. */
  sources: RecordSource[]
  /** e.g. "public address tracking" — never a claim of ownership or authentication. */
  connection?: string
  /** Whether opening balances / full history are declared. Connection status is not accounting completeness. */
  openingDeclared: boolean
}
export interface FinRecord {
  key: string; accountId: string; source: RecordSource; batch: string | null
  time: string; type: RecordType
  instrument: string | null; side: 'YES' | 'NO' | null
  quantity: number | null; price: number | null
  /** Cash amount for deposits, withdrawals, standalone fees, redemptions. */
  amount: number | null
  /** null = fee not reported (unknown), 0 = known fee-free. */
  fee: number | null
}

export const SAMPLE_ACCOUNTS: WorkspaceAccount[] = [
  { id: 'acc-pm-a', venue: 'pm', label: 'Wallet A', kind: 'connected', sources: ['api', 'csv'], connection: 'public address tracking', openingDeclared: true },
  { id: 'acc-pm-b', venue: 'pm', label: 'Wallet B', kind: 'imported', sources: ['csv'], openingDeclared: false },
  { id: 'acc-ks', venue: 'ks', label: 'Main account', kind: 'connected', sources: ['api'], connection: 'read-only API key', openingDeclared: true },
]

const r = (key: string, accountId: string, source: RecordSource, time: string, type: RecordType, x: Partial<FinRecord> = {}): FinRecord =>
  ({ key, accountId, source, batch: x.batch ?? null, time, type, instrument: null, side: null, quantity: null, price: null, amount: null, fee: null, ...x })

export const SAMPLE_RECORDS: FinRecord[] = [
  r('a-001', 'acc-pm-a', 'api', '2026-08-03T14:02:00Z', 'deposit', { amount: 5000, fee: 0 }),
  r('a-002', 'acc-pm-a', 'api', '2026-08-04T09:15:00Z', 'buy', { instrument: 'Bitcoin above $150k on Dec 31', side: 'YES', quantity: 4000, price: 0.32, fee: 0 }),
  r('a-003', 'acc-pm-a', 'api', '2026-08-19T16:40:00Z', 'buy', { instrument: 'Celtics win 2027 NBA Finals', side: 'YES', quantity: 3000, price: 0.2, fee: 0 }),
  r('a-004', 'acc-pm-a', 'api', '2026-09-08T11:05:00Z', 'buy', { instrument: 'Government shutdown before Feb 1', side: 'YES', quantity: 2500, price: 0.36, fee: 0 }),
  r('a-005', 'acc-pm-a', 'api', '2026-09-30T13:20:00Z', 'sell', { instrument: 'Celtics win 2027 NBA Finals', side: 'YES', quantity: 1000, price: 0.24, fee: 0 }),
  r('a-006', 'acc-pm-a', 'api', '2026-10-14T10:00:00Z', 'buy', { instrument: 'Fed rate cut in December?', side: 'YES', quantity: 2000, price: 0.58, fee: 0 }),
  r('a-007', 'acc-pm-a', 'api', '2026-10-14T10:00:00Z', 'buy', { instrument: 'Fed rate cut in December?', side: 'YES', quantity: 2000, price: 0.58, fee: 0 }),
  r('a-008', 'acc-pm-a', 'api', '2026-11-02T18:30:00Z', 'settlement', { instrument: 'Incumbent wins Springfield mayoral election', side: 'YES', quantity: 1500, price: 1, fee: 0 }),
  r('a-009', 'acc-pm-a', 'api', '2026-11-03T08:12:00Z', 'redemption', { instrument: 'Incumbent wins Springfield mayoral election', side: 'YES', amount: 1500, fee: 0 }),
  r('b-001', 'acc-pm-b', 'csv', '2026-07-01T00:00:00Z', 'deposit', { amount: 2500, fee: 0, batch: 'wallet-b-2026.csv' }),
  r('b-002', 'acc-pm-b', 'csv', '2026-07-02T12:00:00Z', 'buy', { instrument: 'Bitcoin above $150k on Dec 31', side: 'YES', quantity: 3000, price: 0.36, fee: null, batch: 'wallet-b-2026.csv' }),
  r('b-003', 'acc-pm-b', 'csv', '2026-09-12T15:30:00Z', 'buy', { instrument: 'Chiefs win Super Bowl LXI', side: 'YES', quantity: 2000, price: 0.17, fee: null, batch: 'wallet-b-2026.csv' }),
  r('b-004', 'acc-pm-b', 'csv', '2026-10-20T09:45:00Z', 'sell', { instrument: 'Chiefs win Super Bowl LXI', side: 'YES', quantity: 500, price: 0.14, fee: null, batch: 'wallet-b-2026.csv' }),
  r('k-001', 'acc-ks', 'api', '2026-08-10T10:00:00Z', 'deposit', { amount: 5000, fee: 0 }),
  r('k-002', 'acc-ks', 'api', '2026-09-21T14:10:00Z', 'buy', { instrument: 'Fed cuts rates at Dec 2026 FOMC', side: 'YES', quantity: 2100, price: 0.56, fee: 8.23 }),
  r('k-003', 'acc-ks', 'api', '2026-10-12T14:20:00Z', 'buy', { instrument: 'Fed cuts rates at Dec 2026 FOMC', side: 'YES', quantity: 1300, price: 0.59, fee: 5.37 }),
  r('k-004', 'acc-ks', 'api', '2026-10-19T09:00:00Z', 'buy', { instrument: 'Nov CPI YoY above 3.0%', side: 'NO', quantity: 1500, price: 0.69, fee: 5.08 }),
  r('k-005', 'acc-ks', 'api', '2026-10-28T09:30:00Z', 'buy', { instrument: 'Nov CPI YoY above 3.0%', side: 'NO', quantity: 900, price: 0.72, fee: 3.39 }),
  r('k-006', 'acc-ks', 'api', '2026-11-04T16:00:00Z', 'fee', { amount: 1.5, fee: null }),
  r('k-007', 'acc-ks', 'api', '2026-11-09T11:11:00Z', 'buy', { instrument: 'ETH ETFs net inflows > $1B in Nov', side: 'YES', quantity: 1750, price: 0.43, fee: 7.5 }),
  r('k-008', 'acc-ks', 'api', '2026-11-12T08:00:00Z', 'withdrawal', { amount: 750, fee: 0 }),
]

/** Sample CSV files offered by the import flow (nothing is read from the user's disk in this build). */
export interface SampleFile { name: string; about: string; rows: Omit<FinRecord, 'key' | 'accountId' | 'source' | 'batch'>[] }
export const SAMPLE_FILES: SampleFile[] = [
  {
    name: 'wallet-a-history-2026-h1.csv', about: 'Older trades for Wallet A, before the connection started (supplement). Two rows match records the connection already has.',
    rows: [
      { time: '2026-08-03T14:02:00Z', type: 'deposit', instrument: null, side: null, quantity: null, price: null, amount: 5000, fee: 0 },
      { time: '2026-08-04T09:15:00Z', type: 'buy', instrument: 'Bitcoin above $150k on Dec 31', side: 'YES', quantity: 4000, price: 0.32, amount: null, fee: 0 },
      { time: '2026-05-11T10:00:00Z', type: 'deposit', instrument: null, side: null, quantity: null, price: null, amount: 1500, fee: 0 },
      { time: '2026-05-12T12:30:00Z', type: 'buy', instrument: 'US recession declared in 2027', side: 'NO', quantity: 1200, price: 0.78, amount: null, fee: 0 },
      { time: '2026-06-02T09:00:00Z', type: 'sell', instrument: 'US recession declared in 2027', side: 'NO', quantity: 400, price: 0.8, amount: null, fee: null },
    ],
  },
  {
    name: 'wallet-c-export.csv', about: 'A separate wallet’s history (independent account). Nothing in it is matched to other accounts.',
    rows: [
      { time: '2026-06-15T10:00:00Z', type: 'deposit', instrument: null, side: null, quantity: null, price: null, amount: 1000, fee: 0 },
      { time: '2026-06-16T11:20:00Z', type: 'buy', instrument: 'Solana above $500 on Dec 31', side: 'YES', quantity: 2000, price: 0.1, amount: null, fee: 0 },
      { time: '2026-07-30T17:45:00Z', type: 'buy', instrument: 'Lakers win 2027 Finals', side: 'YES', quantity: 1500, price: 0.08, amount: null, fee: null },
    ],
  },
]
