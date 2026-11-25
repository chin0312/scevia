ALTER TABLE "scevia"."cash_movements" DROP CONSTRAINT "cash_movements_nonzero_amount";--> statement-breakpoint
DROP INDEX "scevia"."cash_balance_snapshots_account_external_unique";--> statement-breakpoint
DROP INDEX "scevia"."position_snapshots_account_external_unique";--> statement-breakpoint
DROP INDEX "scevia"."price_observations_account_external_unique";--> statement-breakpoint
DROP INDEX "scevia"."position_snapshots_latest_idx";--> statement-breakpoint
ALTER TABLE "scevia"."cash_balance_snapshots" ADD COLUMN "sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "scevia"."cash_balance_snapshots" ADD COLUMN "is_current" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "observed_record_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "observed_record_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "coverage_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "coverage_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "last_attempt_status" "scevia"."sync_status";--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "last_attempt_coverage_status" "scevia"."coverage_status";--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "last_attempt_reason_code" text;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "last_successful_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "is_current" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."source_record_revisions" ADD COLUMN "source_revision_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."source_record_revisions" ADD COLUMN "revision_type" text DEFAULT 'superseded' NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."source_records" ADD COLUMN "source_revision_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."sync_checkpoints" ADD COLUMN "durable_checkpoint" text;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "checkpoint_at_start" text;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "checkpoint_at_end" text;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "position_snapshot_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "cash_balance_snapshot_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "scevia"."sync_runs" ("provider_account_id", "sync_name", "status", "started_at", "finished_at")
SELECT "provider_account_id", 'legacy_snapshot_import', 'complete', now(), now()
FROM (
  SELECT "provider_account_id" FROM "scevia"."position_snapshots"
  UNION
  SELECT "provider_account_id" FROM "scevia"."cash_balance_snapshots"
) AS legacy_accounts;--> statement-breakpoint
UPDATE "scevia"."position_snapshots" AS snapshot
SET "sync_run_id" = (
  SELECT run."id" FROM "scevia"."sync_runs" AS run
  WHERE run."provider_account_id" = snapshot."provider_account_id" AND run."sync_name" = 'legacy_snapshot_import'
  ORDER BY run."started_at" DESC LIMIT 1
);--> statement-breakpoint
UPDATE "scevia"."cash_balance_snapshots" AS snapshot
SET "sync_run_id" = (
  SELECT run."id" FROM "scevia"."sync_runs" AS run
  WHERE run."provider_account_id" = snapshot."provider_account_id" AND run."sync_name" = 'legacy_snapshot_import'
  ORDER BY run."started_at" DESC LIMIT 1
);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ALTER COLUMN "sync_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."cash_balance_snapshots" ALTER COLUMN "sync_run_id" SET NOT NULL;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", "quantity", row_number() OVER (PARTITION BY "provider_account_id", "instrument_id" ORDER BY "observed_at" DESC, "ingested_at" DESC, "id" DESC) AS rank
  FROM "scevia"."position_snapshots"
)
UPDATE "scevia"."position_snapshots" AS snapshot SET "is_current" = true
FROM ranked WHERE snapshot."id" = ranked."id" AND ranked.rank = 1 AND ranked."quantity" <> 0;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "provider_account_id", "asset_code" ORDER BY "observed_at" DESC, "ingested_at" DESC, "id" DESC) AS rank
  FROM "scevia"."cash_balance_snapshots"
)
UPDATE "scevia"."cash_balance_snapshots" AS snapshot SET "is_current" = true
FROM ranked WHERE snapshot."id" = ranked."id" AND ranked.rank = 1;--> statement-breakpoint
UPDATE "scevia"."data_coverage" SET "last_attempt_at" = "retrieved_at";--> statement-breakpoint
ALTER TABLE "scevia"."cash_balance_snapshots" ADD CONSTRAINT "cash_balance_snapshots_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "scevia"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD CONSTRAINT "position_snapshots_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "scevia"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_balance_snapshots_observation_unique" ON "scevia"."cash_balance_snapshots" USING btree ("provider_account_id","external_id","observed_at","sync_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_balance_snapshots_current_unique" ON "scevia"."cash_balance_snapshots" USING btree ("provider_account_id","asset_code") WHERE "scevia"."cash_balance_snapshots"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "position_snapshots_observation_unique" ON "scevia"."position_snapshots" USING btree ("provider_account_id","external_id","observed_at","sync_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "position_snapshots_current_unique" ON "scevia"."position_snapshots" USING btree ("provider_account_id","instrument_id") WHERE "scevia"."position_snapshots"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "price_observations_account_external_time_unique" ON "scevia"."price_observations" USING btree ("provider_account_id","external_id","observed_at");--> statement-breakpoint
CREATE INDEX "position_snapshots_latest_idx" ON "scevia"."position_snapshots" USING btree ("provider_account_id","instrument_id","observed_at","ingested_at");--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" DROP COLUMN "history_start";--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" DROP COLUMN "history_end";--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" DROP COLUMN "retrieved_at";--> statement-breakpoint
ALTER TABLE "scevia"."cash_movements" ADD CONSTRAINT "cash_movements_direction_sign" CHECK (("scevia"."cash_movements"."movement_kind" = 'deposit' AND "scevia"."cash_movements"."signed_amount" > 0) OR ("scevia"."cash_movements"."movement_kind" = 'withdrawal' AND "scevia"."cash_movements"."signed_amount" < 0) OR "scevia"."cash_movements"."movement_kind" IN ('transfer', 'adjustment'));
