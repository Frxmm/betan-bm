import { test, expect } from 'bun:test'

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only-0000000000'
const { judge } = await import('./pricingEffects')

test('pocos cambios → pocos_datos', () => {
  expect(judge(-10, 5, 20, 3).verdict).toBe('pocos_datos')
})
test('rebaja con muchas más reservas después → funciona', () => {
  const j = judge(-8, 10, 20, 12)
  expect(j.verdict).toBe('funciona'); expect(j.liftPct).toBe(100)
})
test('rebaja sin más reservas → sin_efecto', () => {
  expect(judge(-8, 10, 10, 12).verdict).toBe('sin_efecto')
})
test('rebaja y caen las reservas → perjudica', () => {
  expect(judge(-8, 10, 6, 12).verdict).toBe('perjudica')
})
test('subida que no hunde reservas → funciona; si las hunde → perjudica', () => {
  expect(judge(10, 10, 9, 12).verdict).toBe('funciona')
  expect(judge(10, 10, 5, 12).verdict).toBe('perjudica')
})
test('sin reservas antes: lift null si tampoco hay después', () => {
  expect(judge(-8, 0, 0, 12).liftPct).toBeNull()
})
