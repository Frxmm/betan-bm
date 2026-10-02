// Detecta si una reserva es de EMPRESA: su NIF de facturación tiene forma de
// CIF español (letra de tipo de entidad + 7 dígitos + dígito/letra de
// control), no de DNI (8 dígitos + letra) ni NIE (X/Y/Z + 7 dígitos + letra)
// de un particular. No valida el dígito de control — solo la FORMA, que
// basta para distinguir empresa de persona.
const CIF_RE = /^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/i

export function isCompanyNif(nif: string | null | undefined): boolean {
  if (!nif) return false
  const clean = nif.trim().toUpperCase().replace(/[\s-]/g, '')
  return CIF_RE.test(clean)
}
