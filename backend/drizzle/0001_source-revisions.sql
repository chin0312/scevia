CREATE TABLE "scevia"."source_record_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"normalization_version" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scevia"."source_record_revisions" ADD CONSTRAINT "source_record_revisions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "scevia"."source_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_revisions_hash_unique" ON "scevia"."source_record_revisions" USING btree ("source_record_id","payload_sha256");--> statement-breakpoint
CREATE INDEX "source_record_revisions_recorded_idx" ON "scevia"."source_record_revisions" USING btree ("source_record_id","recorded_at");