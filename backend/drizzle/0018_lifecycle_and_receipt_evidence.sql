CREATE TABLE "scevia"."market_lifecycle_evidence" (
	"market_id" uuid NOT NULL,
	"revision" text PRIMARY KEY NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"lifecycle" text NOT NULL,
	"trading_opens_at" timestamp with time zone,
	"trading_closes_at" timestamp with time zone,
	"expected_resolution_at" timestamp with time zone,
	"resolution" jsonb,
	"conflict" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."polymarket_receipt_reviews" (
	"account_id" uuid NOT NULL,
	"transaction_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."market_lifecycle_evidence" ADD CONSTRAINT "market_lifecycle_evidence_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."polymarket_receipt_reviews" ADD CONSTRAINT "polymarket_receipt_reviews_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_lifecycle_cutoff_idx" ON "scevia"."market_lifecycle_evidence" USING btree ("market_id","retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "polymarket_receipt_reviews_scope_unique" ON "scevia"."polymarket_receipt_reviews" USING btree ("account_id","transaction_hash");