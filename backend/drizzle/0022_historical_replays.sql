CREATE TABLE "scevia"."historical_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"configuration" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."historical_replays" ADD CONSTRAINT "historical_replays_collection_id_portfolios_id_fk" FOREIGN KEY ("collection_id") REFERENCES "scevia"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "historical_replays_collection_idx" ON "scevia"."historical_replays" USING btree ("collection_id","updated_at");