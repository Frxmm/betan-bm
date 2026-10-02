-- Ajusta lo aplicado en 0098 al diseño final: el gate para "Cobrado en otro
-- turno" reutiliza la descripción normal del pago (financial_transactions.
-- description, ya existente desde antes) en vez de un campo "comment" nuevo.
ALTER TABLE "financial_transactions" DROP COLUMN "comment";
--> statement-breakpoint
ALTER TABLE "payment_date_corrections" RENAME COLUMN "comment" TO "description";
