ALTER TABLE "scevia"."data_coverage" ADD COLUMN "snapshot_as_of" timestamp with time zone;--> statement-breakpoint
UPDATE "scevia"."data_coverage" AS coverage
SET "snapshot_as_of" = COALESCE(coverage."source_as_of", (
  SELECT MAX(run."finished_at")
  FROM "scevia"."sync_runs" AS run
  WHERE run."provider_account_id" = coverage."provider_account_id"
    AND run."status" = 'complete'
    AND run."position_snapshot_complete" = true
))
WHERE coverage."entity_type" = 'positions'
  AND EXISTS (
    SELECT 1 FROM "scevia"."sync_runs" AS run
    WHERE run."provider_account_id" = coverage."provider_account_id"
      AND run."status" = 'complete'
      AND run."position_snapshot_complete" = true
  );--> statement-breakpoint
UPDATE "scevia"."data_coverage" AS coverage
SET "snapshot_as_of" = COALESCE(coverage."source_as_of", (
  SELECT MAX(run."finished_at")
  FROM "scevia"."sync_runs" AS run
  WHERE run."provider_account_id" = coverage."provider_account_id"
    AND run."status" = 'complete'
    AND run."cash_balance_snapshot_complete" = true
))
WHERE coverage."entity_type" = 'cash_balances'
  AND EXISTS (
    SELECT 1 FROM "scevia"."sync_runs" AS run
    WHERE run."provider_account_id" = coverage."provider_account_id"
      AND run."status" = 'complete'
      AND run."cash_balance_snapshot_complete" = true
  );--> statement-breakpoint
WITH ranked_legacy_positions AS (
  SELECT
    snapshot."id",
    snapshot."quantity",
    snapshot."provider_account_id",
    snapshot."instrument_id",
    row_number() OVER (
      PARTITION BY snapshot."provider_account_id", snapshot."instrument_id"
      ORDER BY snapshot."observed_at" DESC, snapshot."ingested_at" DESC, snapshot."id" DESC
    ) AS rank
  FROM "scevia"."position_snapshots" AS snapshot
  INNER JOIN "scevia"."sync_runs" AS run ON run."id" = snapshot."sync_run_id"
  WHERE run."sync_name" = 'legacy_snapshot_import'
)
UPDATE "scevia"."position_snapshots" AS snapshot
SET "is_current" = true
FROM ranked_legacy_positions AS ranked
WHERE snapshot."id" = ranked."id"
  AND ranked.rank = 1
  AND ranked."quantity" = 0
  AND NOT EXISTS (
    SELECT 1 FROM "scevia"."position_snapshots" AS current
    WHERE current."provider_account_id" = ranked."provider_account_id"
      AND current."instrument_id" = ranked."instrument_id"
      AND current."is_current" = true
  );
