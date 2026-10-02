import { useEffect, useState } from 'react'
import { toast } from '../lib/utils'

// Valoración del servicio de desayunos del día — formulario independiente y
// opcional (no bloquea nada): se auto-carga/guarda contra
// /api/housekeeping/breakfast/rating para la fecha dada. Se usa embebido en
// BreakfastLockGuard, pero no depende de él ni de HousekeepingView.
export default function BreakfastRatingForm({ date, onSaved }: { date: string; onSaved?: () => void }) {
  const [rating, setRating] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [hasExisting, setHasExisting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/housekeeping/breakfast?date=${date}`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        setRating(j.serviceRating?.rating ?? null)
        setNotes(j.serviceRating?.notes ?? '')
        setHasExisting(!!j.serviceRating)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [date])

  const save = async () => {
    if (rating == null) return
    setSaving(true)
    try {
      await fetch('/api/housekeeping/breakfast/rating', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, rating, notes: notes || undefined }),
      })
      setHasExisting(true)
      toast('Valoración guardada')
      onSaved?.()
    } catch { toast('Error guardando la valoración', 'err') }
    finally { setSaving(false) }
  }

  if (loading) return <div style={{ fontSize: 13, color: 'var(--text2)' }}>Cargando…</div>

  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>¿Cómo ha ido el servicio hoy? <span style={{ fontWeight: 400, color: 'var(--text2)' }}>(opcional)</span></div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
          <button key={n} onClick={() => setRating(n)}
            className={`btn btn-sm${rating === n ? ' btn-primary' : ' btn-ghost'}`}
            style={{ minWidth: 32, padding: '4px 0' }}>{n}</button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>1 = muchas quejas · 5 = alguna queja · 10 = ninguna queja, todo perfecto</div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notas (opcional)" style={{ width: '100%', marginBottom: 8 }} />
      <button className="btn btn-primary btn-sm" onClick={save} disabled={rating == null || saving}>
        {saving ? 'Guardando…' : hasExisting ? 'Actualizar valoración' : 'Guardar valoración'}
      </button>
    </div>
  )
}
