CREATE TABLE "scevia"."reviewed_binary_rules" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"yes_instrument_id" uuid NOT NULL,
	"no_instrument_id" uuid NOT NULL,
	"asset_code" text NOT NULL,
	"evidence" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reviewed_binary_distinct_legs" CHECK ("scevia"."reviewed_binary_rules"."yes_instrument_id" <> "scevia"."reviewed_binary_rules"."no_instrument_id"),
	CONSTRAINT "reviewed_binary_evidence_required" CHECK (length(trim("scevia"."reviewed_binary_rules"."evidence")) > 0)
);
--> statement-breakpoint
CREATE TABLE "scevia"."reviewed_settlement_constraints" (
	"left_market_id" uuid NOT NULL,
	"right_market_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"evidence" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reviewed_settlement_constraint_distinct_markets" CHECK ("scevia"."reviewed_settlement_constraints"."left_market_id" <> "scevia"."reviewed_settlement_constraints"."right_market_id"),
	CONSTRAINT "reviewed_settlement_constraint_kind" CHECK ("scevia"."reviewed_settlement_constraints"."kind" in ('equivalent','exclusive','implies')),
	CONSTRAINT "reviewed_settlement_constraint_evidence_required" CHECK (length(trim("scevia"."reviewed_settlement_constraints"."evidence")) > 0)
);
--> statement-breakpoint
ALTER TABLE "scevia"."reviewed_binary_rules" ADD CONSTRAINT "reviewed_binary_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "scevia"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."reviewed_binary_rules" ADD CONSTRAINT "reviewed_binary_rules_yes_instrument_id_instruments_id_fk" FOREIGN KEY ("yes_instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."reviewed_binary_rules" ADD CONSTRAINT "reviewed_binary_rules_no_instrument_id_instruments_id_fk" FOREIGN KEY ("no_instrument_id") REFERENCES "scevia"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."reviewed_settlement_constraints" ADD CONSTRAINT "reviewed_settlement_constraints_left_market_id_reviewed_binary_rules_market_id_fk" FOREIGN KEY ("left_market_id") REFERENCES "scevia"."reviewed_binary_rules"("market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scevia"."reviewed_settlement_constraints" ADD CONSTRAINT "reviewed_settlement_constraints_right_market_id_reviewed_binary_rules_market_id_fk" FOREIGN KEY ("right_market_id") REFERENCES "scevia"."reviewed_binary_rules"("market_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewed_settlement_constraint_unique" ON "scevia"."reviewed_settlement_constraints" USING btree ("left_market_id","right_market_id","kind");