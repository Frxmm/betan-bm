ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "original_total" NUMERIC(10,2);

-- Sin backfill retroactivo a propósito: solo se rellena a partir de ahora,
-- al importar reservas nuevas desde FDM (src/routes/fdm.ts, scripts/fdm-import.ts).
-- Reservas ya existentes se quedan en NULL — el informe de comisiones usa
-- "total" como respaldo para esas.
