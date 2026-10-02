import { test, expect } from 'bun:test'
import { countWords, hasMinWords } from './textValidation'

test('cuenta palabras normales separadas por espacios', () => {
  expect(countWords('el huésped pidió cambiar de habitación')).toBe(6)
})
test('la puntuación sola no cuenta como palabra', () => {
  expect(countWords('. . . . .')).toBe(0)
  expect(countWords('a ; ; ; ; ;')).toBe(1)
})
test('puntuación pegada a una palabra real sí cuenta', () => {
  expect(countWords('reserva, hab. checked_in; virtual: ok.')).toBe(5)
})
test('hasMinWords respeta el mínimo exacto', () => {
  expect(hasMinWords('una dos tres cuatro cinco', 5)).toBe(true)
  expect(hasMinWords('una dos tres cuatro', 5)).toBe(false)
  expect(hasMinWords(null, 5)).toBe(false)
})
