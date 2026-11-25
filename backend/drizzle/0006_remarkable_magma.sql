CREATE TABLE "scevia"."activity_fact_occurrences" (
	"sync_run_id" uuid NOT NULL,
	"activity_fact_id" uuid NOT NULL,
	"observations" integer NOT NULL,
	CONSTRAINT "activity_fact_occurrences_positive" CHECK ("scevia"."activity_fact_occurrences"."observations" > 0)
);
--> statement-breakpoint
ALTER TABLE "scevia"."activity_fact_occurrences" ADD CONSTRAINT "activity_fact_occurrences_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "scevia"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."activity_fact_occurrences" ADD CONSTRAINT "activity_fact_occurrences_activity_fact_id_provider_activity_facts_id_fk" FOREIGN KEY ("activity_fact_id") REFERENCES "scevia"."provider_activity_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_fact_occurrences_run_fact_unique" ON "scevia"."activity_fact_occurrences" USING btree ("sync_run_id","activity_fact_id");--> statement-breakpoint
CREATE INDEX "activity_fact_occurrences_fact_idx" ON "scevia"."activity_fact_occurrences" USING btree ("activity_fact_id");