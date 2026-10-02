-- Al hacer check-out/cancelar/revocar a mano ya no se borra zkteco_card_no ni
-- zkteco_card_be — se marca aquí, para poder reutilizar la misma tarjeta
-- física en una reserva consecutiva del mismo huésped (misma habitación,
-- entrada = salida de la anterior) sin que la vuelva a pasar. "Tarjeta activa
-- ahora mismo" = zkteco_card_no IS NOT NULL AND zkteco_card_revoked_at IS NULL.
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "zkteco_card_revoked_at" timestamptz;
