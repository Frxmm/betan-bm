import { useState, useEffect } from 'react'
import { Modal } from './Modal'
import { useAuth, hasRole, type AuthUser } from '../contexts/AuthContext'
import { useProperty } from '../contexts/PropertyContext'

// Aviso de responsabilidad para recepción, una vez al día al entrar — solo
// recepción (no admin/dirección, que no hace el trabajo operativo del día a
// día). "Visto ya hoy" se guarda en localStorage, igual criterio que
// EngagementWeeklyPopup.tsx (por navegador, no por cuenta — si se pierde se
// vuelve a ver, no hay nada que proteger aquí más que el recordatorio).
const STORAGE_KEY = 'daily-reception-reminder-seen'
// Tiempo mínimo visible antes de poder cerrarlo — igual idea que
// ImportantStaffMessagePopup.tsx (HOLD_SECONDS), pero aquí disfrazado de
// carga del propio sistema (ver "ready" más abajo) en vez de un botón con
// cuenta atrás visible, para que no se perciba como una espera impuesta.
const HOLD_SECONDS = 10
const todayISO = (tz?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined }).format(new Date())

function shouldShowReminder(user: AuthUser | null, enabled: boolean, tz?: string): boolean {
  if (!enabled || !hasRole(user, 'recepcion')) return false
  let seenToday = ''
  try { seenToday = localStorage.getItem(STORAGE_KEY) ?? '' } catch { /* privado/bloqueado: se mostrará cada vez, sin más */ }
  return seenToday !== todayISO(tz)
}

export default function DailyReceptionReminderPopup() {
  const { user } = useAuth()
  // Solo si el tenant lo activa (settings ui.dailyReminder.enabled); título/texto opcionales.
  const { property, loaded } = useProperty()
  const cfg = property.dailyReminder
  // Inicializador perezoso: se decide en el PRIMER render, no en un efecto
  // que corre después del primer pintado — así el resto de la app nunca
  // llega a pintarse sin el aviso encima, ni un instante. Si se decidiera en
  // un useEffect habría un primer frame con el contenido ya interactivo
  // antes de que apareciera el popup (visto al revisar cómo se abre: Layout
  // solo monta este componente después de que AuthContext ya haya resuelto
  // al usuario, así que aquí `user` ya es el definitivo, no hace falta
  // esperar a un efecto para leerlo).
  const [open, setOpen] = useState(() => loaded && shouldShowReminder(user, cfg?.enabled === true, property.timezone))
  const [ready, setReady] = useState(false)

  // El tenant puede terminar de cargarse después del primer render.
  useEffect(() => {
    if (loaded && shouldShowReminder(user, cfg?.enabled === true, property.timezone)) setOpen(true)
  }, [loaded, cfg?.enabled, user, property.timezone])

  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => setReady(true), HOLD_SECONDS * 1000)
    return () => clearTimeout(id)
  }, [open])

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, todayISO(property.timezone)) } catch {}
    setOpen(false)
  }

  if (!open) return null
  return (
    <Modal title={cfg?.title || "⚠️ Antes de empezar"} onClose={dismiss} blocking footer={
      ready
        ? <button className="btn btn-primary" onClick={dismiss}>Entendido, lo tengo en cuenta</button>
        : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text2)', fontSize: 13 }}>
            <span className="daily-reminder-spinner" /> Cargando sistema…
          </div>
        )
    }>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>
        {cfg?.body ? cfg.body.split(/\n{2,}/).map((p, i) => <p key={i} style={{ marginTop: i ? 12 : 0, whiteSpace: 'pre-line' }}>{p}</p>) : <DefaultReminder />}
      </div>
    </Modal>
  )
}

function DefaultReminder() {
  return (
    <>
        <p>
          Este sistema no es un entorno de pruebas: cada cambio que haces aquí — una habitación,
          una fecha, un cobro, una cancelación — es algo real para una persona que está o va a
          estar alojada en el hotel. Un cambio hecho sin pensar, o sin dejar explicado el motivo,
          puede acabar generando una situación incómoda delante del cliente.
        </p>
        <p style={{ marginTop: 12, fontWeight: 600 }}>Por eso:</p>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li style={{ marginBottom: 6 }}>
            Entra siempre con tu propio usuario — nunca con la cuenta de un compañero. Si una
            acción queda registrada a nombre de otra persona, se pierde la trazabilidad real de
            quién hizo qué.
          </li>
          <li style={{ marginBottom: 6 }}>
            Todo cambio que afecte a una reserva queda en una nota, siempre — no solo cuando
            "parece importante".
          </li>
          <li style={{ marginBottom: 6 }}>
            Lo que el cliente ve y vive en el hotel tiene que coincidir en todo momento con lo que
            hay aquí dentro. Si hay alguna diferencia, se corrige antes de que el cliente la note,
            no después.
          </li>
          <li>
            Antes de acabar tu turno, comprueba que no quede ninguna alerta urgente sin resolver —
            le pasas al siguiente turno una recepción limpia, no pendientes arrastrados.
          </li>
        </ul>
        <p style={{ marginTop: 12, color: 'var(--text2)' }}>
          Gracias por tomártelo en serio — es lo que nos permite dar un buen servicio.
        </p>
    </>
  )
}
