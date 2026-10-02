-- Tabla configurable de formas de pago (reemplaza el enum fijo)
CREATE TABLE IF NOT EXISTS payment_method_configs (
  id          SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL DEFAULT 1,
  key         TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#64748b',
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(property_id, key)
);

INSERT INTO payment_method_configs (key, label, color, sort_order) VALUES
  ('cash',                 'Efectivo',           '#22c55e', 1),
  ('credit_card',          'Tarjeta',            '#4f7cff', 2),
  ('bank_transfer',        'Transferencia',      '#06b6d4', 3),
  ('stripe',               'Stripe',             '#a855f7', 4),
  ('booking_virtual_card', 'Virtual Booking',    '#f59e0b', 5),
  ('deposit',              'Depósito efectivo',  '#f97316', 6),
  ('deposit_cc',           'Depósito CC',        '#fb923c', 7),
  ('jumbo_credit',         'Jumbo a crédito',    '#e879f9', 8),
  ('other',                'Otro',               '#64748b', 9)
ON CONFLICT DO NOTHING;

-- Cambiar columna payment_method de enum a text para permitir valores personalizados
ALTER TABLE financial_transactions
  ALTER COLUMN payment_method TYPE text
  USING payment_method::text;
