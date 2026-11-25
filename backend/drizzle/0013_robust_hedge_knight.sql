CREATE TABLE "scevia"."portfolio_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"baseline" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."portfolio_scenarios" ADD CONSTRAINT "portfolio_scenarios_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_scenarios_portfolio_idx" ON "scevia"."portfolio_scenarios" USING btree ("portfolio_id");