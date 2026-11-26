CREATE TABLE "scevia"."market_history_windows" (
	"revision" text PRIMARY KEY NOT NULL,
	"instrument_id" uuid NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"next_cursor" text
);
--> statement-breakpoint
ALTER TABLE "scevia"."fx_references" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scevia"."market_history_windows" ADD CONSTRAINT "market_history_windows_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_history_windows_retrieval_idx" ON "scevia"."market_history_windows" USING btree ("retrieved_at");