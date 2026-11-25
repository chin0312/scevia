import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const database = new PGlite()

async function applyMigration(filename: string): Promise<void> {
  const source = await readFile(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8')
  for (const statement of source.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
    await database.exec(statement)
  }
}

afterAll(async () => {
  await database.close()
})

describe('sync integrity migration upgrade', () => {
  it('backfills legacy position and cash snapshots without losing coverage state', async () => {
    await applyMigration('0000_foundation.sql')
    await applyMigration('0001_source-revisions.sql')
    await database.exec(`
      INSERT INTO scevia.users (id, auth_subject)
      VALUES ('00000000-0000-4000-8000-000000000001', 'legacy-test');
      INSERT INTO scevia.portfolios (id, owner_id, name)
      VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'Legacy');
      INSERT INTO scevia.provider_accounts (id, portfolio_id, provider_code, external_account_id, label, kind)
      VALUES ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'fixture', 'acct', 'Legacy', 'fixture');
      INSERT INTO scevia.events (id, provider_code, external_id, name)
      VALUES ('00000000-0000-4000-8000-000000000301', 'fixture', 'event', 'Event');
      INSERT INTO scevia.markets (id, event_id, provider_code, external_id, title)
      VALUES ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000301', 'fixture', 'market', 'Market');
      INSERT INTO scevia.instruments (id, market_id, external_id, outcome_name) VALUES
        ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000401', 'yes', 'Yes'),
        ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000401', 'no', 'No');
      INSERT INTO scevia.source_records (id, provider_account_id, record_type, external_record_id, payload, payload_sha256, normalization_version, retrieved_at) VALUES
        ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000201', 'position', 'pos-active', '{}', 'active', '1', '2026-11-20T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000201', 'position', 'pos-closed-old', '{}', 'closed-old', '1', '2026-11-19T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000603', '00000000-0000-4000-8000-000000000201', 'position', 'pos-closed-zero', '{}', 'closed-zero', '1', '2026-11-21T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000604', '00000000-0000-4000-8000-000000000201', 'cash_balance', 'cash', '{}', 'cash', '1', '2026-11-20T00:00:00Z');
      INSERT INTO scevia.position_snapshots (id, provider_account_id, instrument_id, source_record_id, external_id, observed_at, quantity, origin, ingested_at) VALUES
        ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000601', 'pos-active', '2026-11-20T00:00:00Z', 10, 'provider_reported', '2026-11-20T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000602', 'pos-closed-old', '2026-11-19T00:00:00Z', 2, 'provider_reported', '2026-11-19T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000703', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000603', 'pos-closed-zero', '2026-11-21T00:00:00Z', 0, 'provider_reported', '2026-11-21T00:00:00Z');
      INSERT INTO scevia.cash_balance_snapshots (id, provider_account_id, source_record_id, external_id, observed_at, balance, asset_code, ingested_at)
      VALUES ('00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000604', 'cash', '2026-11-20T00:00:00Z', 0, 'USD', '2026-11-20T00:00:00Z');
      INSERT INTO scevia.data_coverage (provider_account_id, entity_type, status, history_start, history_end, retrieved_at)
      VALUES
        ('00000000-0000-4000-8000-000000000201', 'positions', 'complete', '2026-11-19T00:00:00Z', '2026-11-21T00:00:00Z', '2026-11-20T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000201', 'cash_balances', 'complete', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z');
    `)

    await applyMigration('0002_sync_integrity_hardening.sql')
    await database.exec(`
      UPDATE scevia.sync_runs SET position_snapshot_complete = true, cash_balance_snapshot_complete = true
      WHERE sync_name = 'legacy_snapshot_import';
      UPDATE scevia.data_coverage SET source_as_of = '2026-11-21T00:00:00Z'
      WHERE entity_type IN ('positions', 'cash_balances');
    `)
    await applyMigration('0003_phase1_snapshot_watermark.sql')

    const positions = await database.query(`
      SELECT id::text, instrument_id::text, quantity::text, is_current, sync_run_id::text
      FROM scevia.position_snapshots ORDER BY observed_at
    `)
    const cash = await database.query(`
      SELECT is_current, sync_run_id::text FROM scevia.cash_balance_snapshots
      WHERE id = '00000000-0000-4000-8000-000000000704'
    `)
    const coverage = await database.query(`
      SELECT status::text, last_attempt_at::text, snapshot_as_of::text
      FROM scevia.data_coverage WHERE entity_type = 'positions'
    `)
    const cashCoverage = await database.query(`
      SELECT snapshot_as_of::text
      FROM scevia.data_coverage WHERE entity_type = 'cash_balances'
    `)
    const activePosition = positions.rows.find((row) => row.id === '00000000-0000-4000-8000-000000000701')
    const oldClosedPosition = positions.rows.find((row) => row.id === '00000000-0000-4000-8000-000000000702')
    const zeroClosedPosition = positions.rows.find((row) => row.id === '00000000-0000-4000-8000-000000000703')

    expect(activePosition?.is_current).toBe(true)
    expect(oldClosedPosition?.is_current).toBe(false)
    expect(zeroClosedPosition?.is_current).toBe(true)
    expect(activePosition?.sync_run_id).toBeTruthy()
    expect(cash.rows[0]?.is_current).toBe(true)
    expect(cash.rows[0]?.sync_run_id).toBe(activePosition?.sync_run_id)
    expect(coverage.rows[0]?.status).toBe('complete')
    expect(String(coverage.rows[0]?.last_attempt_at)).toContain('2026-11-20')
    expect(String(coverage.rows[0]?.snapshot_as_of)).toContain('2026-11-21')
    expect(String(cashCoverage.rows[0]?.snapshot_as_of)).toContain('2026-11-21')
    expect(zeroClosedPosition?.is_current).toBe(true)
  })
})
