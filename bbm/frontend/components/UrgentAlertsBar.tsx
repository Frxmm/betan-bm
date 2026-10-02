import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from '../lib/utils'

type UrgentAlert = {
  id: string; message: string; reservationId?: number
  doneAction?: { label: string; navigateTo?: string; confirmEndpoint?: string }
  severity?: 'urgent' | 'warning' | 'info' | 'suggestion'
  // Alerta agrupada: una sola línea desplegable con estos elementos dentro.
  items?: { label: string; reservationId?: number }[]
}

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutos

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
  const [alerts,    setAlerts]    = useState<UrgentAlert[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [busy,       setBusy]     = useState<Set<string>>(new Set())
  const [expanded,   setExpanded] = useState<Set<string>>(new Set())

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
  if (visible.length === 0) return null

  return (
    <div style={{
      position: 'sticky', top: 52, zIndex: 40,
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      {visible.map(alert => {
        const s        = SEVERITY_STYLE[alert.severity ?? 'urgent']
        const hasItems = !!alert.items?.length
        const isOpen   = expanded.has(alert.id)
        return (
        <div key={alert.id} style={{ background: s.bg, color: s.fg }}>
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
  )
}
