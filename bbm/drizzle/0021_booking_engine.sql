-- Motor de reservas: tokens de autenticación de clientes (magic link)
CREATE TABLE IF NOT EXISTS customer_tokens (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at    TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_tokens_token_idx ON customer_tokens(token);
CREATE INDEX IF NOT EXISTS customer_tokens_email_idx ON customer_tokens(email);

-- Stripe session ID en reservas (reutilizamos extra_field1)
-- No requiere columna nueva, se almacena en extra_field1 con prefijo 'stripe:'
