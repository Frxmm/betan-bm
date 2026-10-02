import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth, hasRole } from '../contexts/AuthContext'
import { Modal } from './Modal'
import BreakfastRatingForm from './BreakfastRatingForm'

// ── Bloqueo de salida en Desayunos (solo rol Limpieza, 09:30-11:30) ─────────
// Objetivo: que quien lleva los desayunos no se vaya a otra pantalla a medio
// servicio sin darse cuenta. En cuanto abre la pestaña "Desayunos" de
// Housekeeping dentro de la ventana horaria (armBreakfastLock(), llamado
// desde HousekeepingView), cualquier clic que le saque de /housekeeping hacia
// otra parte de la web queda interceptado y le pide confirmar que ya ha
// marcado todos los desayunos. Al confirmar, se desbloquea hasta el día
// siguiente (la marca de armado/confirmado es por fecha, en localStorage —
// una conveniencia de ESTE navegador: si la ventana horaria pasa de las
// 11:30 sin confirmar, se libera sola, para no dejar a nadie atrapado por
// error). No bloquea nada DENTRO de /housekeeping (cambiar de pestaña,
// marcar servido, valorar el servicio…), solo la salida hacia otra vista.
const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())

function madridMinutesNow(): number {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date())
  const hh = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
  const mm = Number(parts.find(p => p.type === 'minute')?.value ?? 0)
  return hh * 60 + mm
}
const WINDOW_START = 9 * 60 + 30   // 09:30
const WINDOW_END    = 11 * 60 + 30  // 11:30
export const inBreakfastLockWindow = () => {
  const m = madridMinutesNow()
  return m >= WINDOW_START && m <= WINDOW_END
}

// Por fecha Y por usuario — así si otro usuario (limpieza u otro rol) entra
// luego en el mismo dispositivo, no hereda el bloqueo de quien abrió
// Desayunos antes que él/ella. Cada persona solo se bloquea por lo que ELLA
// misma abrió y no confirmó.
const armKey     = (userId: number) => `breakfast-lock-armed-${madridToday()}-${userId}`
const confirmKey = (userId: number) => `breakfast-lock-confirmed-${madridToday()}-${userId}`

// Llamar al abrir la pestaña Desayunos (HousekeepingView) — solo tiene efecto
// dentro de la ventana horaria, ver inBreakfastLockWindow().
export function armBreakfastLock(userId: number) {
  if (!inBreakfastLockWindow()) return
  try { localStorage.setItem(armKey(userId), '1') } catch { /* privado/bloqueado: sin bloqueo, no rompe nada */ }
}

export default function BreakfastLockGuard() {
  const { user } = useAuth()
  const location = useLocation()
  const [blocked, setBlocked] = useState(false)

  const isLimpiezaOnly = !!user && !user.isPrimary && (user.roles ?? []).length === 1 && hasRole(user, 'limpieza')

  let armed = false, confirmed = false
  try {
    if (user) { armed = localStorage.getItem(armKey(user.id)) === '1'; confirmed = localStorage.getItem(confirmKey(user.id)) === '1' }
  } catch { /* ignore */ }

  const active = isLimpiezaOnly && inBreakfastLockWindow() && armed && !confirmed

  useEffect(() => {
    if (!active) return

    const onClickCapture = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const link = target.closest('a[href]') as HTMLAnchorElement | null
      if (!link) return  // solo intercepta enlaces de navegación (menú lateral, topbar…), nunca botones dentro de la propia vista
      if (link.getAttribute('href')?.startsWith('/housekeeping')) return  // moverse dentro de Housekeeping siempre está permitido
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      setBlocked(true)
    }
    // Mejor esfuerzo con el botón atrás del navegador: no hay forma fiable de
    // "cancelar" un popstate ya disparado, así que se vuelve a empujar la
    // misma ruta y se pide confirmación igual.
    const onPopState = () => { window.history.pushState(null, '', '/housekeeping'); setBlocked(true) }

    document.addEventListener('click', onClickCapture, true)
    window.history.pushState(null, '', window.location.pathname + window.location.search)
    window.addEventListener('popstate', onPopState)
    return () => {
      document.removeEventListener('click', onClickCapture, true)
      window.removeEventListener('popstate', onPopState)
    }
  }, [active, location.pathname])

  const confirmDone = () => {
    try { if (user) localStorage.setItem(confirmKey(user.id), '1') } catch { /* ignore */ }
    setBlocked(false)
  }

  if (!active || !blocked) return null
  return (
    <Modal title="🍳 Antes de salir de Desayunos" onClose={() => setBlocked(false)} footer={
      <>
        <button className="btn btn-ghost" onClick={() => setBlocked(false)}>Seguir marcando</button>
        <button className="btn btn-primary" onClick={confirmDone}>Ya he marcado todos los desayunos</button>
      </>
    }>
      <p style={{ margin: '0 0 16px' }}>¿Has marcado ya todos los desayunos de hoy antes de salir a hacer otra cosa?</p>
      <BreakfastRatingForm date={madridToday()} />
    </Modal>
  )
}
