ALTER TABLE "scevia"."sync_runs" DROP CONSTRAINT "sync_runs_records_nonnegative";--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ALTER COLUMN "occurred_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."data_coverage" ADD COLUMN "last_successful_run_id" uuid;--> statement-breakpoint
ALTER TABLE "scevia"."fills" ADD COLUMN "identity_kind" text DEFAULT 'provider_native' NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."markets" ADD COLUMN "event_identity_kind" text DEFAULT 'provider_native' NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ADD COLUMN "identity_kind" text DEFAULT 'source_fingerprint' NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ADD COLUMN "source_endpoint" text DEFAULT 'activity' NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ADD COLUMN "price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "scevia"."provider_activity_facts" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "rows_received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "source_rows_retained" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "invalid_records" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "records_persisted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "exact_duplicates" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "unresolved_records" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "overlap_candidates" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD COLUMN "excluded_records" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."sync_runs" ADD CONSTRAINT "sync_runs_records_nonnegative" CHECK ("scevia"."sync_runs"."records_seen" >= 0 AND "scevia"."sync_runs"."records_rejected" >= 0 AND "scevia"."sync_runs"."rows_received" >= 0 AND "scevia"."sync_runs"."source_rows_retained" >= 0 AND "scevia"."sync_runs"."invalid_records" >= 0 AND "scevia"."sync_runs"."records_persisted" >= 0 AND "scevia"."sync_runs"."exact_duplicates" >= 0 AND "scevia"."sync_runs"."unresolved_records" >= 0 AND "scevia"."sync_runs"."overlap_candidates" >= 0 AND "scevia"."sync_runs"."excluded_records" >= 0);