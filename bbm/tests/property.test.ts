import { test, expect, describe } from 'bun:test'
// property.ts importa la BD (cliente lazy) y env valida variables: valores de relleno, no se conecta.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET ??= 'x'.repeat(32)
const { brandingOf, featureOf, settingOf, DEFAULT_ON, ALL_FEATURES, getPropertyId, runWithProperty, hasPropertyContext } =
  await import('../src/lib/property')

// Fila mínima de `properties` para probar las funciones puras.
const row = (over: Record<string, unknown> = {}) => ({
  id: 7, name: 'Hotel Demo', address: 'Calle Mayor 1', city: 'Madrid', countryCode: 'ES', phone: '910000000',
  email: 'info@example.com', vatNumber: 'B00000000', logoUrl: null, currencyCode: 'EUR', timezone: 'Europe/Madrid',
  slug: null, legalName: null, touristRegistryNumber: null, postalCode: null, region: null, websiteUrl: null,
  publicDomain: null, receptionEmail: null, fromEmail: null, mapsUrl: null, starLabel: null, localeDefault: 'es',
  settings: {}, features: {}, active: true,
  ...over,
}) as any

describe('brandingOf', () => {
  test('rellena valores por defecto sin inventar datos del hotel', () => {
    const b = brandingOf(row())
    expect(b.slug).toBe('hotel7')              // sin slug → hotel<id>
    expect(b.waPrefix).toBe('hotel7')
    expect(b.legalName).toBe('Hotel Demo')     // sin razón social → nombre
    expect(b.receptionEmail).toBe('info@example.com')
    expect(b.fromEmail).toBe('info@example.com')
    expect(b.websiteUrl).toBe('')
    expect(b.localeDefault).toBe('es')
  })
  test('usa los campos propios cuando existen y compone la dirección', () => {
    const b = brandingOf(row({
      slug: 'sol', legalName: 'Sol S.L.', postalCode: '28001', region: 'Madrid',
      receptionEmail: 'rec@sol.com', fromEmail: 'noreply@sol.com', publicDomain: 'reservas.sol.com',
    }))
    expect(b.slug).toBe('sol')
    expect(b.waPrefix).toBe('sol')
    expect(b.legalName).toBe('Sol S.L.')
    expect(b.receptionEmail).toBe('rec@sol.com')
    expect(b.fromEmail).toBe('noreply@sol.com')
    expect(b.fullAddress).toBe('Calle Mayor 1, 28001 Madrid, Madrid')
    expect(b.publicDomain).toBe('reservas.sol.com')
  })
})

describe('featureOf', () => {
  test('sin configuración: solo los módulos DEFAULT_ON', () => {
    for (const k of ALL_FEATURES) expect(featureOf(row(), k)).toBe(DEFAULT_ON.includes(k))
  })
  test('el valor explícito manda sobre el defecto', () => {
    const p = row({ features: { fdm: true, ses: false } })
    expect(featureOf(p, 'fdm')).toBe(true)
    expect(featureOf(p, 'ses')).toBe(false)
    expect(featureOf(p, 'jumbo')).toBe(false)
  })
})

describe('settingOf', () => {
  test('devuelve el valor, o el fallback si falta', () => {
    const p = row({ settings: { 'pricing.rootRateId': 12, 'jumbo.pcId': '99' } })
    expect(settingOf<number>(p, 'pricing.rootRateId')).toBe(12)
    expect(settingOf<string>(p, 'jumbo.pcId')).toBe('99')
    expect(settingOf(p, 'no.existe')).toBeUndefined()
    expect(settingOf(p, 'no.existe', 5)).toBe(5)
  })
  test('un valor falsy presente no se sustituye por el fallback', () => {
    const p = row({ settings: { 'jumbo.availabilityBuffer': 0 } })
    expect(settingOf(p, 'jumbo.availabilityBuffer', 8)).toBe(0)
  })
})

describe('contexto de tenant', () => {
  test('getPropertyId lanza fuera de contexto y no hay fallback', () => {
    expect(hasPropertyContext()).toBe(false)
    expect(() => getPropertyId()).toThrow()
  })
  test('runWithProperty aísla contextos anidados y concurrentes', async () => {
    const ids = await Promise.all([
      runWithProperty(1, async () => { await Bun.sleep(5); return getPropertyId() }),
      runWithProperty(2, async () => getPropertyId()),
    ])
    expect(ids).toEqual([1, 2])
    expect(runWithProperty(3, () => runWithProperty(4, () => getPropertyId()))).toBe(4)
  })
})
