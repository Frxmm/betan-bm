// Campo de motivo para un cambio de habitación delicado (huésped ya en casa,
// o el tipo destino es virtual) — el servidor es quien de verdad lo exige
// (ver src/lib/textValidation.ts, hasMinWords), esto es solo para no dejar
// que el usuario llegue hasta "Guardar" sin haberlo escrito. La cuenta de
// palabras replica la misma regla: la puntuación suelta no cuenta.
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
export const MIN_REASON_WORDS = 5

export function countReasonWords(text: string): number {
  return text.trim().split(/\s+/).filter(tok => HAS_LETTER_OR_DIGIT.test(tok)).length
}

// Cuándo hace falta motivo: reserva con el huésped ya en casa, o la
// habitación elegida es de un tipo virtual (cualquiera que sea el estado).
export function roomChangeNeedsReason(reservationStatus: string, targetRoom: { roomType?: { isVirtual?: boolean } } | null | undefined): boolean {
  return reservationStatus === 'checked_in' || !!targetRoom?.roomType?.isVirtual
}

export function RoomChangeReasonField({ value, onChange, reservationStatus, targetRoom }: {
  value: string
  onChange: (v: string) => void
  reservationStatus: string
  targetRoom: { roomType?: { isVirtual?: boolean; name?: string } } | null | undefined
}) {
  if (!roomChangeNeedsReason(reservationStatus, targetRoom)) return null
  const why = reservationStatus === 'checked_in' && targetRoom?.roomType?.isVirtual
    ? 'el huésped ya está en casa y el nuevo tipo es virtual'
    : reservationStatus === 'checked_in' ? 'el huésped ya está en casa' : 'el nuevo tipo es virtual'
  const words = countReasonWords(value)
  const ok = words >= MIN_REASON_WORDS
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label>Motivo del cambio <span style={{ fontWeight: 400, color: 'var(--text2)' }}>({why}) — obligatorio</span></label>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={2}
        placeholder="Explica por qué se hace este cambio…" />
      <div style={{ fontSize: 11, color: ok ? 'var(--green)' : 'var(--text2)', marginTop: 2 }}>
        {words}/{MIN_REASON_WORDS} palabras{ok ? ' ✓' : ''}
      </div>
    </div>
  )
}
