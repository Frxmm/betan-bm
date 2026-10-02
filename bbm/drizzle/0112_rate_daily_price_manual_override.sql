-- Marca de "editado a mano mientras una regla de umbral seguía activa" — el
-- motor de reglas dinámicas la respeta y no vuelve a tocar el precio hasta
-- que la condición de esa regla se resuelva del todo (episodio nuevo).
ALTER TABLE "rate_daily_prices" ADD COLUMN "manual_override_at" timestamptz;
