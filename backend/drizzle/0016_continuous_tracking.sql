CREATE TABLE "scevia"."account_tracking" (
	"account_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."market_tracking" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"lifecycle" text
);
--> statement-breakpoint
CREATE TABLE "scevia"."market_watches" (
	"portfolio_id" uuid NOT NULL,
	"market_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scevia"."shared_market_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"method" text NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"observed_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"revision" text NOT NULL,
	CONSTRAINT "shared_market_observations_binary_price" CHECK ("scevia"."shared_market_observations"."price" >= 0 and "scevia"."shared_market_observations"."price" <= 1)
);
--> statement-breakpoint
ALTER TABLE "scevia"."account_tracking" ADD CONSTRAINT "account_tracking_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "scevia"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."market_tracking" ADD CONSTRAINT "market_tracking_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."market_watches" ADD CONSTRAINT "market_watches_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."market_watches" ADD CONSTRAINT "market_watches_market_id_market_tracking_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."market_tracking"("market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."shared_market_observations" ADD CONSTRAINT "shared_market_observations_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tracking_source_scope_unique" ON "scevia"."account_tracking" USING btree ("account_id","scope");--> statement-breakpoint
CREATE INDEX "account_tracking_due_idx" ON "scevia"."account_tracking" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "market_tracking_due_idx" ON "scevia"."market_tracking" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_watches_portfolio_market_unique" ON "scevia"."market_watches" USING btree ("portfolio_id","market_id");--> statement-breakpoint
CREATE INDEX "market_watches_market_idx" ON "scevia"."market_watches" USING btree ("market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_market_observations_revision_unique" ON "scevia"."shared_market_observations" USING btree ("revision");--> statement-breakpoint
CREATE INDEX "shared_market_observations_retention_idx" ON "scevia"."shared_market_observations" USING btree ("retrieved_at","id");--> statement-breakpoint
CREATE INDEX "shared_market_observations_lookup_idx" ON "scevia"."shared_market_observations" USING btree ("instrument_id","asset","effective_at");