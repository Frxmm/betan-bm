import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { Modal } from './Modal'

// Cada usuario ve su rating de implicación una vez por semana AL ENTRAR, pero
// SOLO si es mayor de 80 (el objetivo es reconocer, no presionar con un número
// bajo cada semana). "Visto ya esta semana" se guarda en localStorage —
// es solo una conveniencia de este navegador, no se pierde nada si se borra.
const isoWeekKey = (d = new Date()) => {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((+dt - +yearStart) / 86400000 + 1) / 7)
  return `${dt.getUTCFullYear()}-W${week}`
}

export default function EngagementWeeklyPopup() {
  const [rating, setRating] = useState<number | null>(null)

  useEffect(() => {
    const key = 'engagement-weekly-seen'
    let seenWeek = ''
    try { seenWeek = localStorage.getItem(key) ?? '' } catch { /* privado/bloqueado: se mostrará cada vez, sin más */ }
    if (seenWeek === isoWeekKey()) return
    api.engagementMe().then(r => {
      if (r.data?.showWeekly) setRating(r.data.rating)
      try { localStorage.setItem(key, isoWeekKey()) } catch {}
    }).catch(() => {})
  }, [])

  if (rating == null) return null
  return (
    <Modal title="🌟 Tu implicación esta semana" onClose={() => setRating(null)} footer={
      <button className="btn btn-primary" onClick={() => setRating(null)}>Genial</button>
    }>
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        <div style={{ fontSize: 48, fontWeight: 800, color: 'var(--green)' }}>{rating}<span style={{ fontSize: 18, color: 'var(--text2)' }}> / 100</span></div>
        <p style={{ color: 'var(--text2)', fontSize: 13, marginTop: 8 }}>
          Tu rating de implicación con la plataforma va muy bien — sigue así. Puedes ver el detalle en "Implicación" en el menú.
        </p>
      </div>
    </Modal>
  )
}
