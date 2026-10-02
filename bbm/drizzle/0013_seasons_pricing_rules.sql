-- Temporadas: rangos de fechas con precio mínimo para Dir AL
CREATE TABLE "seasons" (
  "id"          serial PRIMARY KEY,
  "property_id" integer NOT NULL REFERENCES "properties"("id"),
  "name"        text NOT NULL,
  "date_from"   date NOT NULL,
  "date_to"     date NOT NULL,
  "min_price"   numeric(10, 2),
  "color"       text NOT NULL DEFAULT '#3b82f6',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

-- Reglas de precio dinámico (p.ej. disponibilidad < 15% → +X%)
CREATE TABLE "pricing_rules" (
  "id"            serial PRIMARY KEY,
  "property_id"   integer NOT NULL REFERENCES "properties"("id"),
  "name"          text NOT NULL,
  "rule_type"     text NOT NULL DEFAULT 'low_availability',
  "threshold_pct" integer NOT NULL DEFAULT 15,
  "adjust_type"   text NOT NULL DEFAULT 'percentage',
  "adjust_value"  numeric(10, 2) NOT NULL DEFAULT 0,
  "active"        boolean NOT NULL DEFAULT true,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);
