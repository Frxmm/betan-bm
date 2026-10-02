-- Contabilidad de coste de IA por tenant y mes (para cobrar la IA por uso).
-- NO aplicar automáticamente: lo ejecuta el usuario.
CREATE TABLE IF NOT EXISTS ai_usage (
  property_id        integer      NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  month              text         NOT NULL, -- 'YYYY-MM' en la zona horaria del hotel
  input_tokens       bigint       NOT NULL DEFAULT 0,
  output_tokens      bigint       NOT NULL DEFAULT 0,
  cache_write_tokens bigint       NOT NULL DEFAULT 0,
  cache_read_tokens  bigint       NOT NULL DEFAULT 0,
  calls              integer      NOT NULL DEFAULT 0,
  cost_usd           numeric(12,5) NOT NULL DEFAULT 0,
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, month)
);
