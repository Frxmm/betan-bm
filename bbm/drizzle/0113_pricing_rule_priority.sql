-- Prioridad configurable de las reglas de precio dinámico (número menor =
-- gana). Solo se aplica UNA regla por fecha: la de menor prioridad entre las
-- que se cumplen ese día. Los valores iniciales reproducen el orden que
-- tenía el motor fijo en código, para no cambiar el comportamiento actual.
ALTER TABLE "pricing_rules" ADD COLUMN "priority" integer NOT NULL DEFAULT 100;
UPDATE "pricing_rules" SET "priority" = CASE "rule_type"
  WHEN 'demand_pulse_dip'      THEN 10
  WHEN 'evening_clearance_dip' THEN 20
  WHEN 'sold_out_upsell'       THEN 30
  WHEN 'lead_time_dip'         THEN 40
  WHEN 'local_min_dip'         THEN 50
  WHEN 'low_availability'      THEN 60
  WHEN 'competitor_undercut'   THEN 70
  ELSE 100 END;
