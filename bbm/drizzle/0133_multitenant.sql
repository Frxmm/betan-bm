-- Multi-tenant: una fila de `properties` = un tenant (hotel). Identidad, branding,
-- ajustes y módulos por tenant. NO aplicar automáticamente: lo ejecuta el usuario.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS slug                    text,
  ADD COLUMN IF NOT EXISTS legal_name              text,
  ADD COLUMN IF NOT EXISTS tourist_registry_number text,
  ADD COLUMN IF NOT EXISTS postal_code             text,
  ADD COLUMN IF NOT EXISTS region                  text,
  ADD COLUMN IF NOT EXISTS website_url             text,
  ADD COLUMN IF NOT EXISTS public_domain           text,
  ADD COLUMN IF NOT EXISTS reception_email         text,
  ADD COLUMN IF NOT EXISTS from_email              text,
  ADD COLUMN IF NOT EXISTS maps_url                text,
  ADD COLUMN IF NOT EXISTS star_label              text,
  ADD COLUMN IF NOT EXISTS locale_default          text NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS admission_terms_html    text,
  ADD COLUMN IF NOT EXISTS settings                jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS features                jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS active                  boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS properties_slug_uniq          ON properties (slug)          WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS properties_public_domain_uniq ON properties (lower(public_domain)) WHERE public_domain IS NOT NULL;

-- Administrador de plataforma: puede crear/editar tenants (página "Tenants").
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;
