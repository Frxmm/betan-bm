INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('no-show-booking', 'Reservas de Booking.com sin marcar No Show en la extranet')
ON CONFLICT DO NOTHING;
