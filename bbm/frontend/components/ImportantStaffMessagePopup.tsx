import { useState, useEffect, useRef } from 'react'
import { Modal } from './Modal'

// Mensajes "Importante Ahora" de dirección (send_staff_message/
// broadcast_staff_message con important=true, ver src/routes/ai.ts) — a
// diferencia de un mensaje normal (burbuja de chat en AgentFloat), estos
// bloquean la pantalla del destinatario con un popup que no se puede cerrar
// con Escape/clic fuera/aspa, y el botón de confirmar lectura ("Leído") está
// deshabilitado con una cuenta atrás de 10s como mínimo — así no se puede
// descartar el aviso sin al menos haber tenido tiempo de leerlo.
interface ImportantMessage {
  id: number
  message: string
  firstName: string
  lastName: string
  createdAt: string
}

const HOLD_SECONDS = 10
const POLL_MS = 30_000

export default function ImportantStaffMessagePopup() {
  const [queue, setQueue] = useState<ImportantMessage[]>([])
  const [secondsLeft, setSecondsLeft] = useState(HOLD_SECONDS)
  const [acking, setAcking] = useState(false)
  const currentIdRef = useRef<number | null>(null)

  useEffect(() => {
    const check = () => {
      fetch('/api/ai/important-messages', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          const data: ImportantMessage[] = d?.data ?? []
          if (!data.length) return
          setQueue(prev => {
            const knownIds = new Set(prev.map(m => m.id))
            const fresh = data.filter(m => !knownIds.has(m.id))
            return fresh.length ? [...prev, ...fresh] : prev
          })
        })
        .catch(() => {})
    }
    check()
    const id = setInterval(check, POLL_MS)
    return () => clearInterval(id)
  }, [])

  const current = queue[0] ?? null

  // Cuenta atrás de HOLD_SECONDS por cada mensaje nuevo que pasa a ser el actual.
  useEffect(() => {
    if (!current) { currentIdRef.current = null; return }
    if (currentIdRef.current === current.id) return // ya está corriendo la cuenta para este
    currentIdRef.current = current.id
    setSecondsLeft(HOLD_SECONDS)
    const id = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(id); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [current])

  const ack = async () => {
    if (!current || secondsLeft > 0 || acking) return
    setAcking(true)
    try {
      await fetch(`/api/ai/important-messages/${current.id}/ack`, { method: 'POST', credentials: 'include' })
    } catch { /* si falla, se reintenta: sigue en la cola porque no lo quitamos hasta éxito */ }
    finally {
      setAcking(false)
      setQueue(prev => prev.filter(m => m.id !== current.id))
    }
  }

  if (!current) return null

  const canAck = secondsLeft <= 0 && !acking

  return (
    <Modal
      title="⚠️ Esto es Importante Ahora"
      onClose={ack}
      blocking
      footer={
        <button className="btn btn-primary" onClick={ack} disabled={!canAck}>
          {acking ? 'Confirmando…' : canAck ? 'Leído' : `Leído (${secondsLeft}s)`}
        </button>
      }
    >
      <div style={{ padding: '4px 0' }}>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 8 }}>
          De {current.firstName} {current.lastName}:
        </p>
        <p style={{ fontSize: 15, fontWeight: 500, whiteSpace: 'pre-wrap' }}>{current.message}</p>
      </div>
    </Modal>
  )
}
