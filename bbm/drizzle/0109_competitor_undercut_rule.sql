-- Nueva regla de precio dinámico "competitor_undercut": baja el precio de una
-- tarifa de referencia (configurable) cuando es más cara que el competidor más
-- barato ese día y la ocupación está floja. Ver src/lib/pricingRulesEngine.ts.
ALTER TABLE "pricing_rules" ADD COLUMN "reference_rate_id" integer REFERENCES "rates"("id");
