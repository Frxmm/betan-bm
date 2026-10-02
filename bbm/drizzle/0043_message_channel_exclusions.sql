-- Exclusiones por canal de venta: reservas de estos canales no reciben el mensaje
ALTER TABLE "message_settings"
  ADD COLUMN IF NOT EXISTS "excluded_channel_ids" jsonb NOT NULL DEFAULT '[]';
