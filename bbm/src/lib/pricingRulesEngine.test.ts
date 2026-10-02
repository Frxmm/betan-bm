import { test, expect } from 'bun:test'

// El motor importa db/env al cargarse; estas pruebas solo usan funciones puras,
// así que basta con un DATABASE_URL de mentira (postgres conecta perezoso, no se usa).
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only-0000000000'
const { applyAdjust, findLocalMinimaDates } = await import('./pricingRulesEngine')

const addDays = (base: string, n: number) => {
  const d = new Date(`${base}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
test('applyAdjust: porcentaje hacia abajo y hacia arriba', () => {
  expect(applyAdjust(100, 'percentage', 10, -1)).toBe(90)
  expect(applyAdjust(100, 'percentage', 10, 1)).toBe(110)
})

test('applyAdjust: importe fijo', () => {
  expect(applyAdjust(100, 'fixed', 15, -1)).toBe(85)
  expect(applyAdjust(100, 'fixed', 15, 1)).toBe(115)
})

test('applyAdjust: redondea a céntimos y nunca baja de 0', () => {
  expect(applyAdjust(33.33, 'percentage', 7, -1)).toBe(31)
  expect(applyAdjust(10, 'fixed', 50, -1)).toBe(0)
})

test('findLocalMinimaDates: un valle claro por debajo del umbral se marca', () => {
  const from = '2026-01-01'
  // La ventana pide offsets 2..61 (3..60 ±1 de contexto): todo 80 salvo un valle en el offset 10
  const m = new Map(Array.from({ length: 60 }, (_, i) => [addDays(from, i + 2), i + 2 === 10 ? 30 : 80] as [string, number]))
  expect([...findLocalMinimaDates(m, from, 3, 60, 50)]).toEqual([addDays(from, 10)])
})

test('findLocalMinimaDates: valle por encima del umbral no se marca', () => {
  const from = '2026-01-01'
  const m = new Map(Array.from({ length: 60 }, (_, i) => [addDays(from, i + 2), i + 2 === 10 ? 70 : 90] as [string, number]))
  expect(findLocalMinimaDates(m, from, 3, 60, 50).size).toBe(0)
})

test('findLocalMinimaDates: datos incompletos no marcan nada', () => {
  const from = '2026-01-01'
  const m = new Map([[addDays(from, 5), 10]])
  expect(findLocalMinimaDates(m, from, 3, 60, 50).size).toBe(0)
})

test('findLocalMinimaDates: meseta plana entera no es un mínimo', () => {
  const from = '2026-01-01'
  const m = new Map(Array.from({ length: 60 }, (_, i) => [addDays(from, i + 2), 20] as [string, number]))
  expect(findLocalMinimaDates(m, from, 3, 60, 50).size).toBe(0)
})
