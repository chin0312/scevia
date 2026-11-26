CREATE TABLE "scevia"."automatic_market_watches" (
	"portfolio_id" uuid NOT NULL,
	"market_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD COLUMN "lifecycle_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD COLUMN "metadata_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD COLUMN "quote_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD COLUMN "quote_status" text;--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD COLUMN "resolution" jsonb;--> statement-breakpoint
ALTER TABLE "scevia"."automatic_market_watches" ADD CONSTRAINT "automatic_market_watches_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."automatic_market_watches" ADD CONSTRAINT "automatic_market_watches_market_id_market_tracking_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."market_tracking"("market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_market_watches_portfolio_market_unique" ON "scevia"."automatic_market_watches" USING btree ("portfolio_id","market_id");--> statement-breakpoint
CREATE INDEX "automatic_market_watches_market_idx" ON "scevia"."automatic_market_watches" USING btree ("market_id");