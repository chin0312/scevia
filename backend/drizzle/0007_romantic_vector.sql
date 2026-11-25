CREATE TABLE "scevia"."financial_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"observations" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scevia"."financial_import_batches" ADD CONSTRAINT "financial_import_batches_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_import_batches_portfolio_content" ON "scevia"."financial_import_batches" USING btree ("portfolio_id","content_hash");