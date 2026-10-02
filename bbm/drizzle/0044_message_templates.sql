-- Plantillas de email personalizables (si no hay fila, se usa la de fábrica)
CREATE TABLE IF NOT EXISTS "message_templates" (
  "key"        text PRIMARY KEY,
  "subject"    text NOT NULL,
  "html"       text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
