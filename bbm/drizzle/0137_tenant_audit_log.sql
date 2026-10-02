-- Auditoría de acciones de plataforma sobre tenants (alta, edición, módulos,
-- credenciales, impersonación). NO aplicar automáticamente: lo ejecuta el usuario.
CREATE TABLE IF NOT EXISTS tenant_audit_log (
  id               serial PRIMARY KEY,
  platform_user_id integer REFERENCES users(id),
  property_id      integer REFERENCES properties(id),
  action           text NOT NULL,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_audit_log_property_idx ON tenant_audit_log (property_id, created_at DESC);
