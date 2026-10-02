-- ═══════════════════════════════════════════════════════════════════════════════
-- Backfill del tenant existente (properties.id = 1, primer cliente) tras la
-- migración 0133_multitenant. NO es una migración: la ejecuta el usuario a mano.
--
--   1. Haz backup:   pg_dump -Fc -d <db> -f antes-backfill.dump
--   2. Aplica antes 0133 (columnas slug, legal_name, settings, features, is_platform_admin…)
--   3. Ejecuta:      psql -d <db> -v ON_ERROR_STOP=1 -f scripts/tenant-betania-backfill.sql
--
-- Es idempotente (se puede repetir) y va en una transacción: si algo falla, no cambia nada.
-- Este fichero es, junto con scripts/legacy-betania/, el ÚNICO sitio donde puede aparecer el nombre del primer cliente.
-- Los ids de FDM/Jumbo son los que estaban hardcodeados en el código (ver docs/03-DESACOPLAMIENTO-HOTEL.md).
-- ═══════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Identidad y branding ──────────────────────────────────────────────────
UPDATE properties SET
  slug                    = 'betania',                                  -- además fija el prefijo WhatsApp: betania_checkin, betania_pago…
  legal_name              = 'NEW ALAMOS INTERNACIONAL 2015 SL',
  vat_number              = 'B93439339',
  tourist_registry_number = 'RTA-H/MA/02015',
  address                 = 'C/ Carril de Contreras 12',                -- dirección del contrato; la factura usa "Urbanización El Faro, Blq Betania": ajusta si procede
  postal_code             = COALESCE(postal_code, '29639'),
  region                  = COALESCE(region, 'Málaga'),
  phone                   = COALESCE(NULLIF(phone, ''), '952577786'),
  email                   = COALESCE(NULLIF(email, ''), 'info@hotelbetania.es'),
  website_url             = 'https://hotelbetania.es',
  public_domain           = 'booking.hotelbetania.online',
  reception_email         = 'recepcion@hotelbetania.es',
  from_email              = 'Hotel Betania <recepcion@hotelbetania.es>',
  maps_url                = 'https://www.google.com/maps/search/?api=1&query=Hotel+Betania+Benalm%C3%A1dena',
  star_label              = '**',
  logo_url                = COALESCE(NULLIF(logo_url, ''), 'https://hotelbetania.es/assets/img/logo.png'),
  currency_code           = 'EUR',
  timezone                = 'Europe/Madrid',
  updated_at              = now()
WHERE id = 1;

-- ── 2. Módulos: este tenant tenía todo encendido ─────────────────────────────
UPDATE properties SET features = jsonb_build_object(
  'ttlock', true, 'zkteco', true, 'ses', true, 'whatsapp', true, 'stripe', true, 'nobeds', true,
  'fdm', true, 'jumbo', true, 'pool', true, 'competitors', true, 'events', true, 'pricingRules', true,
  'ai', true, 'voice', true, 'bookingEngine', true, 'portal', true, 'laundry', true, 'cashDrawer', true
) WHERE id = 1;

-- ── 3. Settings: ids en vez de nombres mágicos ───────────────────────────────
-- Los ids se buscan por nombre/código UNA vez, aquí; a partir de ahora el código solo usa ids.
-- Si algún lookup devuelve NULL, jsonb_strip_nulls lo omite y la ruta correspondiente avisará con error claro.
UPDATE properties p SET settings = COALESCE(p.settings, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  -- Motor de precios: tarifa raíz (la antigua 'Dir AL')
  'pricing.rootRateId', (SELECT id FROM rates WHERE property_id = 1 AND code = 'Dir AL' ORDER BY id LIMIT 1),
  -- Motor de reservas: canal web y cuenta de cobro online
  'bookingEngine.channelId',       (SELECT id FROM booking_channels WHERE property_id = 1 AND name = 'Web directa' ORDER BY id LIMIT 1),
  'bookingEngine.stripeAccountId', (SELECT id FROM financial_accounts WHERE property_id = 1 AND name = 'Stripe online' ORDER BY id LIMIT 1),
  -- Canales exentos del aviso "reservas sin cobrar" (antes por nombre: jumbo, agoda)
  'channels.exemptFromUnpaidAlert', (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM booking_channels
                                      WHERE property_id = 1 AND (lower(name) LIKE '%jumbo%' OR lower(name) LIKE '%agoda%')),

  -- FDM (PMS anterior): property 9713, moneda 423, tarifas 27/28, usos de habitación 4/5/8
  'fdm.propertyId', 9713,
  'fdm.currencyId', 423,
  'fdm.baseUrl',    'https://0t6ab-api-premium.frontdeskmaster.com',
  'fdm.reportsUrl', 'https://api-reports-premium.frontdeskmaster.com',
  'fdm.rates',      jsonb_build_array(
                      jsonb_build_object('fdmRateId', 27, 'localCode', 'Dir AL'),
                      jsonb_build_object('fdmRateId', 28, 'localCode', 'Dir HD')),
  'fdm.roomUses',   jsonb_build_array(
                      jsonb_build_object('id', 4, 'label', 'Cuádruple',  'contains', 'Cuádruple'),
                      jsonb_build_object('id', 5, 'label', 'Individual', 'contains', 'Individual'),
                      jsonb_build_object('id', 8, 'label', 'Doble',      'contains', 'Doble')),
  -- cuenta FDM → cuenta financiera local (ids 1-6 de seed-financial-accounts) y → método de pago
  'fdm.accountMap', jsonb_build_object(
    'local',     jsonb_build_object('1',1,'2',2,'3',3,'5',4,'6',3,'7',3,'8',1,'9',3,'10',1,'11',5,'12',6,'13',2),
    'payMethod', jsonb_build_object('1','cash','2','credit_card','3','bank_transfer','5','stripe','6','jumbo_credit',
                                    '7','bank_transfer','8','cash','9','bank_transfer','10','cash','11','deposit',
                                    '12','deposit_cc','13','booking_virtual_card')),

  -- Jumbo (tour operador): contrato de venta 7783 / gestor 6 / pc 988538
  'jumbo.buildingId', '7783',
  'jumbo.handlerId',  '6',
  'jumbo.pcId',       '988538',
  'jumbo.rateIds',    'BAR:M00,BAR:M00:NRF:PRO,BAR:M00:NRF',
  'jumbo.roomIds',    'RX8,8QOI,SGL',
  'jumbo.boardIds',   'RO,BB',
  'jumbo.availabilityBuffer', 8,
  'jumbo.rateId',     (SELECT id FROM rates WHERE property_id = 1 AND code = 'JUMBO AL' ORDER BY id LIMIT 1),
  -- 'jumbo.roomTypeId': tipo de referencia del precio Jumbo; si no se define se usa rates.room_type_id de esa tarifa
  'jumbo.invoiceTo',  jsonb_build_object(
    'billingName',    'JUMBONLINE ACCOMMODATIONS & SERVICES SL',
    'billingNif',     'B56619968',
    'billingAddress', 'Polígono Son Valentí C/ del Calçat 2A, Bjos. Palma de Mallorca, Illes Baleares (07011)'),

  -- WhatsApp: sin overrides; el prefijo sale del slug ('betania_checkin', 'betania_pago'…) = plantillas ya aprobadas en Meta
  'whatsapp.templates', '{}'::jsonb
))
WHERE p.id = 1;

-- ── 4. Administrador de plataforma ───────────────────────────────────────────
-- Marca como platform admin al usuario PRIMARIO del tenant 1. Cambia el criterio si quieres otro usuario:
--   WHERE email = 'tu@email.com'
UPDATE users SET is_platform_admin = true
WHERE id = (SELECT id FROM users WHERE property_id = 1 AND is_primary = true ORDER BY id LIMIT 1);

-- ── 5. Comprobación (no cambia nada) ─────────────────────────────────────────
SELECT id, slug, legal_name, public_domain, jsonb_pretty(settings) AS settings FROM properties WHERE id = 1;
SELECT id, email, is_platform_admin FROM users WHERE property_id = 1 AND is_platform_admin;

COMMIT;
-- Las credenciales (STRIPE_*, TTLOCK_*, FDM_*, JUMBO_*, SES_*, WHATSAPP_*…) siguen en el .env: o bien
-- mantén ALLOW_ENV_SECRET_FALLBACK=1 mientras sea el único tenant, o cópialas a settings 'secrets.<NOMBRE>' desde la UI de plataforma.
