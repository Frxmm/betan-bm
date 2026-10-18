import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from '../lib/utils'
import { Modal } from './Modal'
import { useAuth, canManage } from '../contexts/AuthContext'

type UrgentAlert = {
  id: string; message: string; reservationId?: number
  doneAction?: { label: string; navigateTo?: string; confirmEndpoint?: string }
  severity?: 'urgent' | 'warning' | 'info' | 'suggestion'
  // Alerta agrupada: una sola línea desplegable con estos elementos dentro.
  items?: { label: string; reservationId?: number }[]
  // Primera vez que se vio ESTA ocurrencia (alert_events.first_seen_at) —
  // base de la escalada de las urgentes, ver ESCALATION_* más abajo.
  firstSeenAt?: string
  // false si ha cambiado el turno de caja desde que se vio por primera vez
  // (o no hay turno abierto ahora) — se muestra como alerta normal, sin
  // parpadeo ni interrupción, porque no la causó quien está ahora de turno.
  escalate?: boolean
  // Solo en la alerta de resumen de fin de turno — se muestra como modal
  // superpuesto en vez de en la barra (ver renderShiftEndSummary más abajo).
  shiftEndSummary?: { total: number; emoji: string; comment: string }
}

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutos

// Escalada de las urgentes (rojas) para que de verdad se atiendan y no se
// ignoren como pasaba hasta ahora: a partir de BLINK_AFTER_MS empiezan a
// parpadear fuerte, y a partir de INTERRUPT_AFTER_MS, si la alerta sigue
// activa, se interrumpe al usuario con un popup bloqueante cada
// INTERRUPT_EVERY_MS — da igual que se haya pulsado "Ignorar" en la barra,
// eso solo oculta el banner, no para la escalada. Se para sola en cuanto la
// alerta se resuelve o Dirección la silencia desde Alertas (deja de venir en
// /api/alerts/urgent, ver src/routes/alerts.ts).
const BLINK_AFTER_MS     = 5  * 60 * 1000
const INTERRUPT_AFTER_MS = 10 * 60 * 1000
const INTERRUPT_EVERY_MS = 10 * 60 * 1000
const TICK_MS = 20_000
const LAST_INTERRUPT_KEY = 'urgentAlertLastInterrupt'

function loadLastInterrupt(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LAST_INTERRUPT_KEY) ?? '{}') } catch { return {} }
}
function saveLastInterrupt(v: Record<string, number>) {
  try { localStorage.setItem(LAST_INTERRUPT_KEY, JSON.stringify(v)) } catch { /* privado/bloqueado: no persiste, pero no rompe nada */ }
}

// Estilo por severidad — 'urgent' (rojo, por defecto) para lo que requiere
// acción inmediata; 'warning' (amarillo) para avisos que no son una urgencia
// (p.ej. incidencias de mantenimiento); 'info' (morado) para notificaciones
// informativas de cambios automáticos del sistema (p.ej. reglas de precio);
// 'suggestion' (azul) para propuestas sin urgencia real, a hacer cuando haya
// un momento (p.ej. llamar a un carrito abandonado) — nunca en rojo, para no
// transmitir presión donde no la hay.
const SEVERITY_STYLE = {
  urgent:     { bg: '#b91c1c', fg: '#fff', prefix: 'Solucionar urgente:', doneFg: '#b91c1c', ignoreBg: 'rgba(255,255,255,0.2)' },
  warning:    { bg: 'var(--yellow, #f59e0b)', fg: '#000', prefix: 'Advertencia:', doneFg: 'var(--yellow, #f59e0b)', ignoreBg: 'rgba(0,0,0,0.15)' },
  info:       { bg: '#7c3aed', fg: '#fff', prefix: 'Info:', doneFg: '#7c3aed', ignoreBg: 'rgba(255,255,255,0.2)' },
  suggestion: { bg: '#2563eb', fg: '#fff', prefix: 'Propuesta:', doneFg: '#2563eb', ignoreBg: 'rgba(255,255,255,0.2)' },
} as const

export default function UrgentAlertsBar() {
  const navigate = useNavigate()
  const { user } = useAuth()
  // Dirección/administración nunca recibe parpadeo ni interrupción bloqueante
  // — sigue viendo la barra normal, solo que sin escalar de ninguna forma.
  const isManager = canManage(user)
  const [alerts,    setAlerts]    = useState<UrgentAlert[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [busy,       setBusy]     = useState<Set<string>>(new Set())
  const [expanded,   setExpanded] = useState<Set<string>>(new Set())
  const [now,        setNow]      = useState(() => Date.now())
  const [interruptQueue, setInterruptQueue] = useState<UrgentAlert[]>([])
  const lastInterruptRef = useRef<Record<string, number>>(loadLastInterrupt())

  const fetchAlerts = useCallback(async () => {
    try {
      const r = await fetch('/api/alerts/urgent', { credentials: 'include' })
      if (!r.ok) return
      const d = await r.json()
      setAlerts(d.data ?? [])
    } catch { /* silencioso */ }
  }, [])

  useEffect(() => {
    fetchAlerts()
    const id = setInterval(fetchAlerts, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [fetchAlerts])

  // Limpiar dismissed cuando la alerta desaparece del servidor
  useEffect(() => {
    const activeIds = new Set(alerts.map(a => a.id))
    setDismissed(prev => {
      const next = new Set([...prev].filter(id => activeIds.has(id)))
      return next.size !== prev.size ? next : prev
    })
  }, [alerts])

  // Reloj propio para el parpadeo y la escalada — independiente del poll de
  // datos, así los umbrales (5/10 min) se cumplen aunque no haya cambiado
  // nada en el servidor entretanto.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  // Encola una interrupción bloqueante por cada urgente que lleve activa
  // INTERRUPT_AFTER_MS o más y no se haya interrumpido ya en los últimos
  // INTERRUPT_EVERY_MS — da igual si está "Ignorada" en la barra o si la
  // alerta ya no está "visible" por eso: la condición real sigue activa en
  // el servidor, así que se sigue avisando hasta que se resuelva o la
  // silencie Dirección.
  useEffect(() => {
    if (isManager) return
    let changed = false
    const queueAdds: UrgentAlert[] = []
    for (const a of alerts) {
      if ((a.severity ?? 'urgent') !== 'urgent' || !a.firstSeenAt || a.escalate === false) continue
      const elapsed = now - new Date(a.firstSeenAt).getTime()
      if (elapsed < INTERRUPT_AFTER_MS) continue
      const last = lastInterruptRef.current[a.id] ?? 0
      if (now - last < INTERRUPT_EVERY_MS) continue
      lastInterruptRef.current[a.id] = now
      changed = true
      queueAdds.push(a)
    }
    if (changed) {
      saveLastInterrupt(lastInterruptRef.current)
      setInterruptQueue(prev => [...prev, ...queueAdds.filter(a => !prev.some(p => p.id === a.id))])
    }
  }, [alerts, now, isManager])

  // Si la alerta se resuelve mientras está en cola (o siendo mostrada), se quita sola.
  useEffect(() => {
    const activeIds = new Set(alerts.map(a => a.id))
    setInterruptQueue(prev => prev.filter(a => activeIds.has(a.id)))
  }, [alerts])

  const handleDone = async (alert: UrgentAlert) => {
    const action = alert.doneAction
    if (!action) return
    if (action.navigateTo) navigate(action.navigateTo)
    if (action.confirmEndpoint) {
      setBusy(prev => new Set([...prev, alert.id]))
      try {
        const r = await fetch(action.confirmEndpoint, { method: 'POST', credentials: 'include' })
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error ?? 'Error') }
      } catch (e: any) {
        toast(e.message ?? 'No se pudo confirmar', 'err')
        setBusy(prev => { const next = new Set(prev); next.delete(alert.id); return next })
        return
      }
      setBusy(prev => { const next = new Set(prev); next.delete(alert.id); return next })
    }
    // Se quita de pantalla al momento (navegar o confirmar ya resuelve la alerta
    // en el servidor); el siguiente poll confirma que ya no vuelve a aparecer.
    setDismissed(prev => new Set([...prev, alert.id]))
  }

  const visible = alerts.filter(a => !dismissed.has(a.id))
  const current = interruptQueue[0] ?? null
  // Resumen de fin de turno: se superpone a lo que el empleado esté haciendo
  // (modal, no banner) en cuanto llega — el propio backend solo lo manda una
  // vez por turno (ver src/routes/alerts.ts), así que basta con "dismissed"
  // local para no repetirlo dentro de la misma sesión de navegador.
  const bannerVisible = visible.filter(a => !a.shiftEndSummary)
  const shiftEndAlert = visible.find(a => a.shiftEndSummary)

  const closeInterrupt = () => setInterruptQueue(prev => prev.slice(1))
  const resolveFromInterrupt = async (alert: UrgentAlert) => {
    await handleDone(alert)
    closeInterrupt()
  }

  const interruptModal = current && (
    <Modal title="🔴 Alerta urgente sin resolver" onClose={closeInterrupt} blocking footer={
      <>
        {current.doneAction && (
          <button className="btn btn-primary" style={{ background: '#b91c1c', borderColor: '#b91c1c' }}
            onClick={() => resolveFromInterrupt(current)} disabled={busy.has(current.id)}>
            {busy.has(current.id) ? '…' : current.doneAction.label}
          </button>
        )}
        <button className="btn btn-ghost" onClick={closeInterrupt}>Entendido</button>
      </>
    }>
      <p style={{ fontSize: 14, fontWeight: 500 }}>
        Por favor, soluciona esta alerta o comunícate con Dirección para arreglarlo:
      </p>
      <p style={{ fontSize: 15, fontWeight: 700, color: '#b91c1c', margin: '10px 0' }}>{current.message}</p>
      <p style={{ fontSize: 12, color: 'var(--text2)' }}>
        Lleva activa más de 10 minutos — seguirá interrumpiendo cada 10 minutos hasta que se resuelva.
      </p>
    </Modal>
  )

  const shiftEndModal = shiftEndAlert?.shiftEndSummary && (
    <Modal title="Resumen de tu turno" onClose={() => setDismissed(prev => new Set([...prev, shiftEndAlert.id]))} footer={
      <>
        <button className="btn btn-primary" onClick={() => { navigate('/engagement'); setDismissed(prev => new Set([...prev, shiftEndAlert.id])) }}>
          Ver en Implicación
        </button>
        <button className="btn btn-ghost" onClick={() => setDismissed(prev => new Set([...prev, shiftEndAlert.id]))}>Cerrar</button>
      </>
    }>
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        <div style={{ fontSize: 48 }}>{shiftEndAlert.shiftEndSummary.emoji}</div>
        <div style={{ fontSize: 36, fontWeight: 800, margin: '8px 0', color: shiftEndAlert.shiftEndSummary.total >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {shiftEndAlert.shiftEndSummary.total >= 0 ? '+' : ''}{shiftEndAlert.shiftEndSummary.total} pts
        </div>
        <p style={{ fontSize: 15, fontWeight: 500 }}>{shiftEndAlert.shiftEndSummary.comment}</p>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginTop: 12 }}>
          Lo tienes disponible con todo el detalle en la pestaña de <strong>Implicación</strong>.
        </p>
      </div>
    </Modal>
  )

  if (bannerVisible.length === 0) return <>{interruptModal}{shiftEndModal}</>

  return (
    <>
    {interruptModal}
    {shiftEndModal}
    <style>{`
      @keyframes urgent-blink {
        0%, 49%   { background-color: #b91c1c; }
        50%, 100% { background-color: #fff200; color: #000; }
      }
      .urgent-blink { animation: urgent-blink 0.5s steps(1) infinite; }
      .urgent-blink a, .urgent-blink button:not(.urgent-blink-btn) { color: inherit !important; }
    `}</style>
    <div style={{
      position: 'sticky', top: 52, zIndex: 40,
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      {bannerVisible.map(alert => {
        const s        = SEVERITY_STYLE[alert.severity ?? 'urgent']
        const hasItems = !!alert.items?.length
        const isOpen   = expanded.has(alert.id)
        const isUrgent = (alert.severity ?? 'urgent') === 'urgent'
        const blinking = !isManager && isUrgent && alert.escalate !== false && !!alert.firstSeenAt && now - new Date(alert.firstSeenAt).getTime() >= BLINK_AFTER_MS
        return (
        <div key={alert.id} className={blinking ? 'urgent-blink' : undefined} style={blinking ? undefined : { background: s.bg, color: s.fg }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 16px', fontSize: 13, fontWeight: 600,
            lineHeight: 1.4,
          }}>
            <span style={{ flexShrink: 0, fontSize: 15 }}>⚠</span>
            <span style={{ flex: 1 }}>
              <span style={{ opacity: 0.85, fontWeight: 400, marginRight: 6 }}>{s.prefix}</span>
              {hasItems ? (
                <button
                  onClick={() => setExpanded(prev => {
                    const next = new Set(prev)
                    next.has(alert.id) ? next.delete(alert.id) : next.add(alert.id)
                    return next
                  })}
                  style={{
                    background: 'none', border: 'none', color: s.fg, font: 'inherit', fontWeight: 600,
                    cursor: 'pointer', padding: 0, textDecoration: 'underline',
                  }}>
                  {isOpen ? '▾' : '▸'} {alert.message} ({alert.items!.length})
                </button>
              ) : alert.reservationId ? (
                <Link to={`/reservations/${alert.reservationId}`}
                  style={{ color: s.fg, textDecoration: 'underline' }}>
                  {alert.message}
                </Link>
              ) : alert.message}
            </span>
            {alert.doneAction && (
              <button
                onClick={() => handleDone(alert)}
                disabled={busy.has(alert.id)}
                style={{
                  background: '#fff', color: s.doneFg, border: 'none', fontWeight: 700,
                  borderRadius: 4, padding: '2px 10px', cursor: busy.has(alert.id) ? 'default' : 'pointer',
                  fontSize: 12, flexShrink: 0, opacity: busy.has(alert.id) ? 0.6 : 1,
                }}>
                {busy.has(alert.id) ? '…' : alert.doneAction.label}
              </button>
            )}
            <button
              onClick={() => setDismissed(prev => new Set([...prev, alert.id]))}
              style={{
                background: s.ignoreBg, border: 'none', color: s.fg,
                borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12,
                flexShrink: 0,
              }}>
              Ignorar
            </button>
          </div>
          {hasItems && isOpen && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: '2px 16px 10px 41px', fontSize: 12, fontWeight: 400,
            }}>
              {alert.items!.map((item, i) => (
                <div key={i}>
                  {item.reservationId ? (
                    <Link to={`/reservations/${item.reservationId}`}
                      style={{ color: s.fg, textDecoration: 'underline' }}>
                      {item.label}
                    </Link>
                  ) : item.label}
                </div>
              ))}
            </div>
          )}
        </div>
        )
      })}
    </div>
    </>
  )
}
