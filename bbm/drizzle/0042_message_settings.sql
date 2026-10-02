-- Configuración de canales por tipo de mensaje al cliente (email / WhatsApp)
CREATE TABLE IF NOT EXISTS "message_settings" (
  "key"        text PRIMARY KEY,
  "email"      boolean NOT NULL DEFAULT true,
  "whatsapp"   boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
