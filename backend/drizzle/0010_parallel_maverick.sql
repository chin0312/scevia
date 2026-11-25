CREATE TABLE "scevia"."portfolio_accounting_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"record_key" text NOT NULL,
	"decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."financial_import_batches" ADD COLUMN "review_digest" text;--> statement-breakpoint
ALTER TABLE "scevia"."financial_import_batches" ADD COLUMN "review_replaces" uuid;--> statement-breakpoint
ALTER TABLE "scevia"."financial_import_batches" ADD COLUMN "manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."financial_import_batches" ADD COLUMN "accept_unlinked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."portfolio_accounting_decisions" ADD CONSTRAINT "portfolio_accounting_decisions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_decision_revision_unique" ON "scevia"."portfolio_accounting_decisions" USING btree ("portfolio_id","revision");--> statement-breakpoint
CREATE INDEX "accounting_decision_record_idx" ON "scevia"."portfolio_accounting_decisions" USING btree ("portfolio_id","record_key","revision");