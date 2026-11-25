CREATE SCHEMA IF NOT EXISTS "scevia";--> statement-breakpoint
CREATE TYPE "scevia"."account_kind" AS ENUM('public_wallet', 'authenticated_account', 'file_import', 'fixture');--> statement-breakpoint
CREATE TYPE "scevia"."cash_movement_kind" AS ENUM('deposit', 'withdrawal', 'transfer', 'adjustment');--> statement-breakpoint
CREATE TYPE "scevia"."coverage_status" AS ENUM('complete', 'partial', 'unavailable', 'unknown');--> statement-breakpoint
CREATE TYPE "scevia"."fee_status" AS ENUM('reported', 'estimated', 'unavailable');--> statement-breakpoint
CREATE TYPE "scevia"."position_origin" AS ENUM('provider_reported', 'reconstructed');--> statement-breakpoint
CREATE TYPE "scevia"."reconciliation_status" AS ENUM('not_started', 'pending', 'matched', 'difference');--> statement-breakpoint
CREATE TYPE "scevia"."relationship_class" AS ENUM('equivalent', 'mutually_exclusive', 'related', 'unknown');--> statement-breakpoint
CREATE TYPE "scevia"."relationship_review" AS ENUM('unverified', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "scevia"."sync_status" AS ENUM('idle', 'running', 'complete', 'partial', 'failed', 'unavailable');--> statement-breakpoint
CREATE TYPE "scevia"."trade_direction" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TABLE "scevia"."cash_balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"balance" numeric(38, 18) NOT NULL,
	"asset_code" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"movement_kind" "scevia"."cash_movement_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"signed_amount" numeric(38, 18) NOT NULL,
	"asset_code" text NOT NULL,
	"fee_amount" numeric(38, 18),
	"fee_status" "scevia"."fee_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_nonzero_amount" CHECK ("scevia"."cash_movements"."signed_amount" <> 0),
	CONSTRAINT "cash_movements_fee_status_consistent" CHECK (("scevia"."cash_movements"."fee_status" = 'unavailable' AND "scevia"."cash_movements"."fee_amount" IS NULL) OR ("scevia"."cash_movements"."fee_status" IN ('reported', 'estimated') AND "scevia"."cash_movements"."fee_amount" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scevia"."data_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"status" "scevia"."coverage_status" NOT NULL,
	"reason_code" text,
	"history_start" timestamp with time zone,
	"history_end" timestamp with time zone,
	"source_as_of" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."event_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_a_id" uuid NOT NULL,
	"event_b_id" uuid NOT NULL,
	"relationship_class" "scevia"."relationship_class" NOT NULL,
	"review" "scevia"."relationship_review" DEFAULT 'unverified' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_relationships_distinct_ordered" CHECK ("scevia"."event_relationships"."event_a_id" < "scevia"."event_relationships"."event_b_id")
);
--> statement-breakpoint
CREATE TABLE "scevia"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_code" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"resolution_rules" text,
	"lifecycle" text DEFAULT 'unknown' NOT NULL,
	"resolves_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"direction" "scevia"."trade_direction" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"fee_amount" numeric(38, 18),
	"fee_status" "scevia"."fee_status" NOT NULL,
	"settlement_asset_code" text NOT NULL,
	"finality" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fills_quantity_positive" CHECK ("scevia"."fills"."quantity" > 0),
	CONSTRAINT "fills_price_nonnegative" CHECK ("scevia"."fills"."price" >= 0),
	CONSTRAINT "fills_fee_status_consistent" CHECK (("scevia"."fills"."fee_status" = 'unavailable' AND "scevia"."fills"."fee_amount" IS NULL) OR ("scevia"."fills"."fee_status" IN ('reported', 'estimated') AND "scevia"."fills"."fee_amount" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scevia"."instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"outcome_name" text NOT NULL,
	"outcome_type" text DEFAULT 'unknown' NOT NULL,
	"payout_amount" numeric(38, 18),
	"settlement_asset_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"lifecycle" text DEFAULT 'unknown' NOT NULL,
	"settlement_rules" text,
	"settlement_asset_code" text,
	"source_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."position_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"average_cost_price" numeric(38, 18),
	"mark_price" numeric(38, 18),
	"mark_at" timestamp with time zone,
	"settlement_asset_code" text,
	"origin" "scevia"."position_origin" NOT NULL,
	"reconciliation_status" "scevia"."reconciliation_status" DEFAULT 'not_started' NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_snapshots_avg_cost_nonnegative" CHECK ("scevia"."position_snapshots"."average_cost_price" IS NULL OR "scevia"."position_snapshots"."average_cost_price" >= 0),
	CONSTRAINT "position_snapshots_mark_nonnegative" CHECK ("scevia"."position_snapshots"."mark_price" IS NULL OR "scevia"."position_snapshots"."mark_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "scevia"."price_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"price_kind" text NOT NULL,
	"asset_code" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_observations_nonnegative" CHECK ("scevia"."price_observations"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "scevia"."provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"external_account_id" text NOT NULL,
	"label" text NOT NULL,
	"kind" "scevia"."account_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scevia"."settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"payout_amount" numeric(38, 18) NOT NULL,
	"asset_code" text NOT NULL,
	"fee_amount" numeric(38, 18),
	"fee_status" "scevia"."fee_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_quantity_positive" CHECK ("scevia"."settlements"."quantity" > 0),
	CONSTRAINT "settlements_payout_nonnegative" CHECK ("scevia"."settlements"."payout_amount" >= 0),
	CONSTRAINT "settlements_fee_status_consistent" CHECK (("scevia"."settlements"."fee_status" = 'unavailable' AND "scevia"."settlements"."fee_amount" IS NULL) OR ("scevia"."settlements"."fee_status" IN ('reported', 'estimated') AND "scevia"."settlements"."fee_amount" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "scevia"."source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"external_record_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"normalization_version" text NOT NULL,
	"source_occurred_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."sync_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"sync_name" text NOT NULL,
	"cursor" text,
	"status" "scevia"."sync_status" DEFAULT 'idle' NOT NULL,
	"last_run_id" uuid,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"sync_name" text NOT NULL,
	"status" "scevia"."sync_status" NOT NULL,
	"cursor_at_start" text,
	"cursor_at_end" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pages_read" integer DEFAULT 0 NOT NULL,
	"records_seen" integer DEFAULT 0 NOT NULL,
	"records_rejected" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	CONSTRAINT "sync_runs_pages_nonnegative" CHECK ("scevia"."sync_runs"."pages_read" >= 0),
	CONSTRAINT "sync_runs_records_nonnegative" CHECK ("scevia"."sync_runs"."records_seen" >= 0 AND "scevia"."sync_runs"."records_rejected" >= 0)
);
--> statement-breakpoint
CREATE TABLE "scevia"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_subject_unique" UNIQUE("auth_subject")
);
--> statement-breakpoint
ALTER TABLE "scevia"."cash_balance_snapshots" ADD CONSTRAINT "cash_balance_snapshots_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."cash_balance_snapshots" ADD CONSTRAINT "cash_balance_snapshots_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."cash_movements" ADD CONSTRAINT "cash_movements_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."cash_movements" ADD CONSTRAINT "cash_movements_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD CONSTRAINT "data_coverage_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."event_relationships" ADD CONSTRAINT "event_relationships_event_a_id_events_id_fk" FOREIGN KEY ("event_a_id") REFERENCES "scevia"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."event_relationships" ADD CONSTRAINT "event_relationships_event_b_id_events_id_fk" FOREIGN KEY ("event_b_id") REFERENCES "scevia"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."fills" ADD CONSTRAINT "fills_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."fills" ADD CONSTRAINT "fills_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."fills" ADD CONSTRAINT "fills_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."instruments" ADD CONSTRAINT "instruments_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."markets" ADD CONSTRAINT "markets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "scevia"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."portfolios" ADD CONSTRAINT "portfolios_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "scevia"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD CONSTRAINT "position_snapshots_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD CONSTRAINT "position_snapshots_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD CONSTRAINT "position_snapshots_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."price_observations" ADD CONSTRAINT "price_observations_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."price_observations" ADD CONSTRAINT "price_observations_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."price_observations" ADD CONSTRAINT "price_observations_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."provider_accounts" ADD CONSTRAINT "provider_accounts_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."settlements" ADD CONSTRAINT "settlements_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."settlements" ADD CONSTRAINT "settlements_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."settlements" ADD CONSTRAINT "settlements_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."source_records" ADD CONSTRAINT "source_records_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD CONSTRAINT "sync_runs_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_balance_snapshots_account_external_unique" ON "scevia"."cash_balance_snapshots" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "cash_balance_snapshots_latest_idx" ON "scevia"."cash_balance_snapshots" USING btree ("provider_account_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movements_account_external_unique" ON "scevia"."cash_movements" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "cash_movements_account_occurred_idx" ON "scevia"."cash_movements" USING btree ("provider_account_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_coverage_account_entity_unique" ON "scevia"."data_coverage" USING btree ("provider_account_id","entity_type");--> statement-breakpoint
CREATE INDEX "data_coverage_account_updated_idx" ON "scevia"."data_coverage" USING btree ("provider_account_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_relationships_pair_unique" ON "scevia"."event_relationships" USING btree ("event_a_id","event_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_provider_external_unique" ON "scevia"."events" USING btree ("provider_code","external_id");--> statement-breakpoint
CREATE INDEX "events_provider_code_idx" ON "scevia"."events" USING btree ("provider_code");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_account_external_unique" ON "scevia"."fills" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "fills_account_occurred_idx" ON "scevia"."fills" USING btree ("provider_account_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_market_external_unique" ON "scevia"."instruments" USING btree ("market_id","external_id");--> statement-breakpoint
CREATE INDEX "instruments_market_id_idx" ON "scevia"."instruments" USING btree ("market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_provider_external_unique" ON "scevia"."markets" USING btree ("provider_code","external_id");--> statement-breakpoint
CREATE INDEX "markets_event_id_idx" ON "scevia"."markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "portfolios_owner_id_idx" ON "scevia"."portfolios" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "position_snapshots_account_external_unique" ON "scevia"."position_snapshots" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "position_snapshots_latest_idx" ON "scevia"."position_snapshots" USING btree ("provider_account_id","instrument_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_observations_account_external_unique" ON "scevia"."price_observations" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "price_observations_instrument_time_idx" ON "scevia"."price_observations" USING btree ("instrument_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_source_unique" ON "scevia"."provider_accounts" USING btree ("portfolio_id","provider_code","external_account_id");--> statement-breakpoint
CREATE INDEX "provider_accounts_portfolio_id_idx" ON "scevia"."provider_accounts" USING btree ("portfolio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_account_external_unique" ON "scevia"."settlements" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "settlements_account_settled_idx" ON "scevia"."settlements" USING btree ("provider_account_id","settled_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_external_unique" ON "scevia"."source_records" USING btree ("provider_account_id","record_type","external_record_id");--> statement-breakpoint
CREATE INDEX "source_records_retrieved_at_idx" ON "scevia"."source_records" USING btree ("provider_account_id","retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_checkpoints_account_name_unique" ON "scevia"."sync_checkpoints" USING btree ("provider_account_id","sync_name");--> statement-breakpoint
CREATE INDEX "sync_checkpoints_lease_idx" ON "scevia"."sync_checkpoints" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "sync_runs_account_started_idx" ON "scevia"."sync_runs" USING btree ("provider_account_id","started_at");
