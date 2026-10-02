// DNI/NIE: formato + letra de control real (algoritmo oficial mod-23), no
// solo la forma — "12345678A" pasaría un regex aunque la letra que le
// corresponde de verdad a ese número sea otra. Compartido entre
// ReservationDetailView (EditGuestModal/AddGuestModal) e IdScanView — antes
// estaba duplicado (una vez con el cálculo de letra, otra sin él).
const DNI_RE = /^\d{8}[A-HJ-NP-TV-Za-hj-np-tv-z]$/
const NIE_RE = /^[XYZxyz]\d{7}[A-HJ-NP-TV-Za-hj-np-tv-z]$/
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'
const checkLetter = (digits: number) => DNI_LETTERS[digits % 23]

// Devuelve null si es válido (o si el tipo no es dni/nie, o no hay número
// que validar), o un mensaje de error listo para mostrar.
export function validateIdDocNumber(idDocType: string | null | undefined, idDocNumberRaw: string): string | null {
  const num = idDocNumberRaw.toUpperCase().replace(/\s/g, '')
  if (!num) return null

  if (idDocType === 'dni') {
    if (!DNI_RE.test(num)) return 'Formato DNI inválido (8 dígitos + letra)'
    const expected = checkLetter(parseInt(num.slice(0, 8), 10))
    if (num[8] !== expected) return `Letra de DNI incorrecta (debería ser ${expected})`
  }
  if (idDocType === 'nie') {
    if (!NIE_RE.test(num)) return 'Formato NIE inválido (X/Y/Z + 7 dígitos + letra)'
    const prefixDigit = { X: '0', Y: '1', Z: '2' }[num[0] as 'X' | 'Y' | 'Z']
    const expected = checkLetter(parseInt(prefixDigit + num.slice(1, 8), 10))
    if (num[8] !== expected) return `Letra de NIE incorrecta (debería ser ${expected})`
  }
  return null
}
