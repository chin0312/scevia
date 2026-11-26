ALTER TABLE "scevia"."fx_references" ADD COLUMN "token_identity" jsonb;--> statement-breakpoint
ALTER TABLE "scevia"."users" ADD COLUMN "fiat_reference_source" text;--> statement-breakpoint
ALTER TABLE "scevia"."users" ADD COLUMN "stablecoin_reference_source" text;--> statement-breakpoint
CREATE INDEX "fx_references_selection_idx" ON "scevia"."fx_references" USING btree ("base","quote","source","methodology","observed_at");