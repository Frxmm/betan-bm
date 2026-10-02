// Cuenta "palabras" reales de un texto: solo cuentan los fragmentos separados
// por espacios que tienen AL MENOS una letra o dígito — así algo como
// ". . . . ." o "; ; ; ; ;" no cuela como 5 palabras solo por tener 5 trozos
// separados por espacios. Un token con puntuación pegada a una palabra de
// verdad (p.ej. "reserva," o "hab.") sí cuenta — solo se descarta la
// puntuación SOLA.
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(tok => HAS_LETTER_OR_DIGIT.test(tok)).length
}

export function hasMinWords(text: string | null | undefined, min: number): boolean {
  return countWords(text ?? '') >= min
}
