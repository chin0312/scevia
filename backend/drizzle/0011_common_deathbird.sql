ALTER TABLE "scevia"."portfolio_accounting_decisions" ADD COLUMN "operation_digest" text;--> statement-breakpoint
ALTER TABLE "scevia"."portfolio_accounting_decisions" ADD COLUMN "operation_count" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_decision_operation_unique" ON "scevia"."portfolio_accounting_decisions" USING btree ("portfolio_id","operation_digest");