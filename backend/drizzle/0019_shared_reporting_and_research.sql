CREATE TABLE "scevia"."fx_references" (
	"revision" text PRIMARY KEY NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"methodology" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fx_references_positive" CHECK ("scevia"."fx_references"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "scevia"."market_instrument_mappings" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"generation" text NOT NULL,
	"subscription_token" text NOT NULL,
	"asset" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"provenance" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."market_research" (
	"owner_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."portfolios" ADD COLUMN "simulation_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."users" ADD COLUMN "reporting_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "scevia"."market_instrument_mappings" ADD CONSTRAINT "market_instrument_mappings_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."market_research" ADD CONSTRAINT "market_research_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "scevia"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."market_research" ADD CONSTRAINT "market_research_market_id_market_tracking_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."market_tracking"("market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_references_pair_idx" ON "scevia"."fx_references" USING btree ("base","quote","observed_at");--> statement-breakpoint
CREATE INDEX "fx_references_retention_idx" ON "scevia"."fx_references" USING btree ("retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_research_owner_market_unique" ON "scevia"."market_research" USING btree ("owner_id","market_id");--> statement-breakpoint
CREATE INDEX "market_research_active_idx" ON "scevia"."market_research" USING btree ("market_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "simulation_collection_owner_unique" ON "scevia"."portfolios" USING btree ("owner_id") WHERE "scevia"."portfolios"."simulation_only";