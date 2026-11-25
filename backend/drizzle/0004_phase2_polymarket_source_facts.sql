CREATE TABLE "scevia"."provider_activity_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"transaction_hash" text,
	"external_market_id" text,
	"external_instrument_id" text,
	"side" text,
	"quantity" numeric(38, 18),
	"amount" numeric(38, 18),
	"asset_code" text,
	"classification" text DEFAULT 'unreconciled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "redeemable" boolean;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "mergeable" boolean;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "archived" boolean;--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_current_value" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_realized_pnl" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_unrealized_pnl" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_total_pnl" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_entry_cost" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_entry_fees" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_total_cost" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_total_size" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."position_snapshots" ADD COLUMN "provider_percent_pnl" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ADD CONSTRAINT "provider_activity_facts_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ADD CONSTRAINT "provider_activity_facts_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_activity_facts_account_external_unique" ON "scevia"."provider_activity_facts" USING btree ("provider_account_id","external_id");--> statement-breakpoint
CREATE INDEX "provider_activity_facts_account_occurred_idx" ON "scevia"."provider_activity_facts" USING btree ("provider_account_id","occurred_at","id");