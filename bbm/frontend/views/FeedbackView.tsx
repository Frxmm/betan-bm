import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { toast } from '../lib/utils'

const SOURCE_LABEL: Record<string, string> = { staff: '👤 Personal', guest: '🛎️ Huésped', ai: '🤖 IA' }

const SENTIMENT: Record<string, { label: string; color: string }> = {
  complaint:  { label: '😠 Queja',      color: 'var(--red)' },
  suggestion: { label: '💡 Sugerencia', color: '#2563eb' },
  neutral:    { label: '😐 Neutro',     color: 'var(--text2)' },
  positive:   { label: '😊 Elogio',     color: 'var(--green)' },
}
const STATUS: Record<string, string> = { open: 'Abierto', in_progress: 'En curso', resolved: 'Resuelto', wontfix: 'Descartado' }
const CATEGORIES = ['limpieza', 'ruido', 'camas', 'wifi', 'desayuno', 'ducha', 'checkin', 'precio', 'trato', 'ubicacion', 'otro']

export default function FeedbackReport() {
  const [rows, setRows]     = useState<any[]>([])
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const [text, setText]     = useState('')
  const [sentiment, setSentiment] = useState('complaint')
  const [category, setCategory]   = useState('otro')
  const [resId, setResId]   = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [comments, setComments] = useState<any[]>([])
  const [comment, setComment]   = useState('')

  const load = useCallback(async () => {
    try { setRows((await api.listFeedback(filter === 'open' ? { open: '1' } : {})).data) }
    catch (e: any) { toast(e.message, 'err') }
  }, [filter])
  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!text.trim()) return
    try {
      const reservationId = resId.trim() ? Number(resId.trim()) : undefined
      await api.createFeedback({ text, sentiment, category, ...(reservationId ? { reservationId } : {}) })
      setText(''); setResId(''); toast('Hilo abierto'); load()
    } catch (e: any) { toast(e.message, 'err') }
  }
  const setStatus = async (id: number, status: string) => {
    try { await api.updateFeedback(id, { status }); load() } catch (e: any) { toast(e.message, 'err') }
  }
  const toggle = async (id: number) => {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id); setComments((await api.feedbackComments(id)).data)
  }
  const addComment = async () => {
    if (!openId || !comment.trim()) return
    try { await api.addFeedbackComment(openId, comment); setComment(''); setComments((await api.feedbackComments(openId)).data) }
    catch (e: any) { toast(e.message, 'err') }
  }

  // Patrones: categorías con más quejas (en lo cargado).
  const complaints: Record<string, number> = {}
  for (const r of rows) if (r.sentiment === 'complaint') complaints[r.category] = (complaints[r.category] ?? 0) + 1
  const top = Object.entries(complaints).sort((a, b) => b[1] - a[1]).slice(0, 4)

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input style={{ flex: '1 1 280px' }} value={text} onChange={e => setText(e.target.value)} placeholder="¿Qué ha dicho el huésped? (queja, elogio, sugerencia…)" />
        <input style={{ width: 110 }} value={resId} onChange={e => setResId(e.target.value)} placeholder="Nº reserva" />
        <select value={sentiment} onChange={e => setSentiment(e.target.value)}>
          {Object.entries(SENTIMENT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        <button className="btn btn-primary" onClick={create}>Abrir hilo</button>
      </div>
      <div className="tabs" style={{ margin: '0 0 12px' }}>
        <button className={`tab-btn${filter === 'open' ? ' active' : ''}`} onClick={() => setFilter('open')}>Abiertos</button>
        <button className={`tab-btn${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>Todos</button>
      </div>
      {top.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--text2)' }}>Quejas más repetidas: {top.map(([c, n]) => `${c} (${n})`).join(' · ')}</p>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Comentario</th><th>Reserva</th><th>De</th><th>Estado</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <>
                <tr key={r.id} onClick={() => toggle(r.id)} style={{ cursor: 'pointer' }}>
                  <td>{r.id}</td><td>{new Date(r.createdAt).toLocaleDateString('es-ES')}</td>
                  <td style={{ color: SENTIMENT[r.sentiment]?.color }}>{SENTIMENT[r.sentiment]?.label}</td>
                  <td>{r.category}</td><td>{r.text}</td>
                  <td onClick={e => e.stopPropagation()}>
                    {r.reservationId
                      ? <Link to={`/reservations/${r.reservationId}`} onClick={e => e.stopPropagation()}>{r.reservationCode}</Link>
                      : '—'}
                  </td>
                  <td>
                    {SOURCE_LABEL[r.source] ?? r.source}
                    {r.guestName ? ` · ${r.guestName}` : r.createdByName ? ` · ${r.createdByName}` : ''}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <select value={r.status} onChange={e => setStatus(r.id, e.target.value)}>
                      {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                </tr>
                {openId === r.id && (
                  <tr key={`c${r.id}`}><td colSpan={8} style={{ background: 'var(--bg2)' }}>
                    {comments.map(c => <div key={c.id} style={{ fontSize: 13, marginBottom: 4 }}>💬 {c.text} <span style={{ color: 'var(--text2)' }}>· {new Date(c.createdAt).toLocaleString('es-ES')}</span></div>)}
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <input style={{ flex: 1 }} value={comment} onChange={e => setComment(e.target.value)} placeholder="Añadir comentario / avance…" />
                      <button className="btn btn-ghost btn-sm" onClick={addComment}>Comentar</button>
                    </div>
                  </td></tr>
                )}
              </>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text2)' }}>Sin hilos</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}
