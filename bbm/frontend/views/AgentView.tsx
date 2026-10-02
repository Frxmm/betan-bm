import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

type Role = 'user' | 'assistant'
interface Msg { role: Role; content: string; actions?: any[] }
interface SessionSummary { sessionId: string; startedAt: string; lastAt: string; messageCount: number; preview: string }

const VIEW_PATHS: Record<string, string> = {
  dashboard: '/dashboard', planning: '/planning', arrivals: '/arrivals',
  departures: '/departures', billing: '/billing', reservations: '/reservations',
  guests: '/guests', rooms: '/rooms',
}

const SUGGESTIONS = [
  'Resumen de hoy',
  'Llegadas de mañana',
  'Busca la reserva de García',
  'Habitaciones disponibles esta semana',
]

export default function AgentView() {
  const navigate                  = useNavigate()
  const [msgs,    setMsgs]        = useState<Msg[]>([])
  const [input,   setInput]       = useState('')
  const [loading, setLoading]     = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sessions,    setSessions]    = useState<SessionSummary[]>([])
  const bottomRef                 = useRef<HTMLDivElement>(null)
  const inputRef                  = useRef<HTMLTextAreaElement>(null)
  const sessionIdRef              = useRef<string | null>(null)

  const loadSessions = () => {
    fetch('/api/ai/sessions', { credentials: 'include' })
      .then(r => r.json()).then(d => setSessions(d.data ?? [])).catch(() => {})
  }

  const toggleHistory = () => {
    setShowHistory(o => {
      if (!o) loadSessions()
      return !o
    })
  }

  const restoreSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/ai/sessions/${sessionId}`, { credentials: 'include' })
      const data = await res.json()
      setMsgs((data.data ?? []).map((m: any) => ({ role: m.role, content: m.content })))
      sessionIdRef.current = sessionId
      setShowHistory(false)
    } catch {}
  }

  // Marca el body para que el CSS pueda ajustar #content sin padding
  useEffect(() => {
    document.body.classList.add('agent-page')
    return () => document.body.classList.remove('agent-page')
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, loading])

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [input])

  const send = async (text: string) => {
    const userMsg = text.trim()
    if (!userMsg || loading) return
    setInput('')
    const history: Msg[] = [...msgs, { role: 'user', content: userMsg }]
    setMsgs(history)
    setLoading(true)
    if (!sessionIdRef.current) sessionIdRef.current = crypto.randomUUID()

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map(m => ({ role: m.role, content: m.content })),
          sessionId: sessionIdRef.current,
        }),
      })
      const data = await res.json()
      const assistantMsg: Msg = {
        role: 'assistant',
        content: data.text ?? '(sin respuesta)',
        actions: data.actions ?? [],
      }
      setMsgs([...history, assistantMsg])

      if (data.navigate?.view) {
        const path = VIEW_PATHS[data.navigate.view]
        if (path) {
          const target = data.navigate.id ? `${path}/${data.navigate.id}` : path
          setTimeout(() => navigate(target), 600)
        }
      }
    } catch (e: any) {
      setMsgs([...history, { role: 'assistant', content: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
  }

  const clear = () => { setMsgs([]); setInput(''); sessionIdRef.current = null }

  return (
    <div className="agent-wrap">
      <div className="agent-messages">
        {msgs.length === 0 && (
          <div className="agent-empty">
            <div className="agent-empty-icon">✦</div>
            <p>Asistente de recepción</p>
            <p className="agent-empty-sub">Pregunta sobre reservas, llegadas, disponibilidad o pide que navegue a una pantalla.</p>
            <div className="agent-suggestions">
              {SUGGESTIONS.map(s => (
                <button key={s} className="agent-suggestion" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={`agent-msg agent-msg-${m.role}`}>
            <div className="agent-bubble">
              <pre className="agent-text">{m.content}</pre>
              {m.actions && m.actions.length > 0 && (
                <div className="agent-actions">
                  {m.actions.map((a, j) => (
                    <details key={j} className="agent-action-detail">
                      <summary>{a.tool}</summary>
                      <pre className="agent-action-json">{JSON.stringify(a.result, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="agent-msg agent-msg-assistant">
            <div className="agent-bubble agent-thinking">
              <span className="agent-dot" /><span className="agent-dot" /><span className="agent-dot" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="agent-input-row" style={{ position: 'relative' }}>
        <button className="btn btn-ghost btn-sm agent-clear" onClick={toggleHistory} title="Sesiones anteriores">🕘</button>
        {msgs.length > 0 && (
          <button className="btn btn-ghost btn-sm agent-clear" onClick={clear} title="Limpiar conversación">✕</button>
        )}
        {showHistory && (
          <div style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, width: 320, maxHeight: 320, overflowY: 'auto',
            background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.45)',
            zIndex: 20, padding: 6,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', padding: '4px 6px', textTransform: 'uppercase' }}>
              Últimas sesiones
            </div>
            {sessions.length === 0 && <div style={{ fontSize: 12, color: 'var(--text2)', padding: '6px' }}>Sin sesiones guardadas</div>}
            {sessions.map(s => (
              <button key={s.sessionId} onClick={() => restoreSession(s.sessionId)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '6px 6px', borderRadius: 6, color: 'var(--text)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.preview || '(sin texto)'}</div>
                <div style={{ fontSize: 10, color: 'var(--text2)' }}>{new Date(s.lastAt).toLocaleString('es-ES')} · {s.messageCount} msjs</div>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="agent-input"
          rows={1}
          placeholder="Pregunta algo…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={loading}
        />
        <button className="btn btn-primary agent-send" onClick={() => send(input)} disabled={loading || !input.trim()}>
          {loading ? '…' : '↑'}
        </button>
      </div>
    </div>
  )
}
