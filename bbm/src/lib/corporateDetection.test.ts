import { test, expect } from 'bun:test'
import { isCompanyNif } from './corporateDetection'

test('CIF de empresa se reconoce', () => {
  expect(isCompanyNif('B56619968')).toBe(true)
  expect(isCompanyNif('A12345674')).toBe(true)
})
test('DNI de particular no se reconoce como empresa', () => {
  expect(isCompanyNif('12345678Z')).toBe(false)
})
test('NIE de particular no se reconoce como empresa', () => {
  expect(isCompanyNif('X1234567L')).toBe(false)
})
test('vacío o null no es empresa', () => {
  expect(isCompanyNif(null)).toBe(false)
  expect(isCompanyNif('')).toBe(false)
})
test('tolera espacios y guiones', () => {
  expect(isCompanyNif('B-5661996-8')).toBe(true)
})
