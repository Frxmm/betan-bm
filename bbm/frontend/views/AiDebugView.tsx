import { useState, useRef, useEffect, useCallback } from 'react'

interface LogEntry { level: string; ns: string; msg: string; data?: any; ts: number }
interface ToolCallTrace {
  name: string; rawArgs: any; parsedArgs: any; argsError: string | null
  result: any; toolError: string | null; elapsed: number
}
interface LLMTrace {
  backend: string; httpStatus: number; elapsed: number
  rawText: string; jsonError: string | null; rawJson: any; normalized: any; fatalError: string | null
}
interface Iteration {
  index: number
  requestMessages: { role: string; content: string }[]
  llmTrace: LLMTrace | null
  toolCalls: ToolCallTrace[]
  done: boolean
  fatalError: string | null
}
interface DebugResult { finalText: string; iterations: Iteration[]; backend: string }
interface SessionSummary { sessionId: string; startedAt: string; lastAt: string; messageCount: number; preview: string }

function Json({ data, collapsed }: { data: any; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed)
  const str = JSON.stringify(data, null, 2)
  if (!open) return (
    <span style={{ color: 'var(--text2)', cursor: 'pointer', fontSize: 11 }} onClick={() => setOpen(true)}>
      [expandir {str.length} chars]
    </span>
  )
  return (
    <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto', lineHeight: 1.5 }}>
      {str}
    </pre>
  )
}

function RawText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!open) return (
    <span style={{ color: 'var(--text2)', cursor: 'pointer', fontSize: 11 }} onClick={() => setOpen(true)}>
      [ver raw ({text.length} chars)]
    </span>
  )
  return (
    <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto', background: '#111', color: '#e5e7eb', padding: 8, borderRadius: 6, lineHeight: 1.5 }}>
      {text}
    </pre>
  )
}

function IterationPanel({ iter }: { iter: Iteration }) {
  const [open, setOpen] = useState(true)
  const hasError = !!iter.fatalError || !!iter.llmTrace?.fatalError || !!iter.llmTrace?.jsonError
  const borderColor = hasError ? 'rgba(239,68,68,.5)' : iter.done ? 'rgba(34,197,94,.4)' : 'var(--border)'
  return (
    <div style={{ border: `1px solid ${borderColor}`, borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: '8px 12px', background: 'var(--bg2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, userSelect: 'none' }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>Iteración {iter.index + 1}</span>
        {iter.llmTrace && (
          <span style={{ fontSize: 11, color: 'var(--text2)' }}>
            {iter.llmTrace.backend} · {iter.llmTrace.elapsed}ms · HTTP {iter.llmTrace.httpStatus}
          </span>
        )}
        {iter.toolCalls.length > 0 && (
          <span style={{ fontSize: 11, color: '#60a5fa' }}>{iter.toolCalls.length} tool call{iter.toolCalls.length > 1 ? 's' : ''}</span>
        )}
        {iter.done && <span style={{ fontSize: 11, color: '#4ade80', marginLeft: 'auto' }}>✓ respuesta final</span>}
        {hasError && <span style={{ fontSize: 11, color: '#f87171', marginLeft: 'auto' }}>✗ error</span>}
        <span style={{ marginLeft: hasError || iter.done ? 0 : 'auto', color: 'var(--text2)', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Fatal error */}
          {iter.fatalError && (
            <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '8px 10px', color: '#f87171', fontSize: 12 }}>
              <strong>Error fatal:</strong> {iter.fatalError}
            </div>
          )}

          {/* LLM trace */}
          {iter.llmTrace && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Respuesta LLM</div>
              {iter.llmTrace.jsonError && (
                <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '6px 10px', color: '#f87171', fontSize: 12, marginBottom: 6 }}>
                  JSON parse error: {iter.llmTrace.jsonError}
                </div>
              )}
              {iter.llmTrace.fatalError && (
                <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '6px 10px', color: '#f87171', fontSize: 12, marginBottom: 6 }}>
                  {iter.llmTrace.fatalError}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>Raw HTTP:</div>
                <RawText text={iter.llmTrace.rawText} />
              </div>
              {iter.llmTrace.normalized?.message && (
                <div style={{ fontSize: 11 }}>
                  <div style={{ color: 'var(--text2)', marginBottom: 4 }}>Normalizado — content ({(iter.llmTrace.normalized.message.content ?? '').length} chars):</div>
                  {iter.llmTrace.normalized.message.content
                    ? <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--bg3)', padding: 8, borderRadius: 6, maxHeight: 200, overflowY: 'auto' }}>{iter.llmTrace.normalized.message.content}</pre>
                    : <span style={{ color: 'var(--text2)', fontStyle: 'italic' }}>(vacío)</span>}
                </div>
              )}
            </div>
          )}

          {/* Tool calls */}
          {iter.toolCalls.map((tc, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '6px 10px', background: 'var(--bg3)', display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ fontSize: 12, fontWeight: 700, color: '#93c5fd' }}>{tc.name}</code>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{tc.elapsed}ms</span>
                {tc.argsError && <span style={{ fontSize: 11, color: '#f87171' }}>args parse error</span>}
                {tc.toolError && <span style={{ fontSize: 11, color: '#f87171' }}>tool error</span>}
              </div>
              <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {tc.argsError ? (
                  <div>
                    <div style={{ fontSize: 11, color: '#f87171', marginBottom: 4 }}>Args parse error: {tc.argsError}</div>
                    <div style={{ fontSize: 11, color: 'var(--text2)' }}>rawArgs:</div>
                    <pre style={{ margin: 0, fontSize: 11, background: '#111', color: '#e5e7eb', padding: 6, borderRadius: 4 }}>{String(tc.rawArgs)}</pre>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 2 }}>Args:</div>
                    <Json data={tc.parsedArgs} />
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 11, color: tc.toolError ? '#f87171' : 'var(--text2)', marginBottom: 2 }}>
                    {tc.toolError ? `Resultado (error):` : 'Resultado:'}
                  </div>
                  <Json data={tc.result} collapsed />
                </div>
              </div>
            </div>
          ))}

          {/* Request messages summary */}
          <details style={{ fontSize: 11 }}>
            <summary style={{ color: 'var(--text2)', cursor: 'pointer' }}>
              Ver mensajes enviados al LLM ({iter.requestMessages.length})
            </summary>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {iter.requestMessages.map((m, j) => (
                <div key={j} style={{ borderLeft: `3px solid ${m.role === 'system' ? '#a78bfa' : m.role === 'user' ? '#60a5fa' : m.role === 'tool' ? '#4ade80' : '#f9a825'}`, paddingLeft: 8 }}>
                  <span style={{ fontSize: 10, color: 'var(--text2)', textTransform: 'uppercase' }}>{m.role}</span>
                  <pre style={{ margin: '2px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflowY: 'auto' }}>{m.content}</pre>
                </div>
              ))}
            </div>
          </details>

        </div>
      )}
    </div>
  )
}

export default function AiDebugView() {
  const [input,     setInput]     = useState('')
  const [messages,  setMessages]  = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [result,    setResult]    = useState<DebugResult | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [logs,      setLogs]      = useState<LogEntry[]>([])
  const [logsOpen,  setLogsOpen]  = useState(true)
  const [backend,      setBackend]      = useState<'ollama' | 'claude'>('ollama')
  const [showHistory,  setShowHistory]  = useState(false)
  const [sessions,     setSessions]     = useState<SessionSummary[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const evtRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  const loadSessions = () => {
    fetch('/api/ai/sessions?source=debug', { credentials: 'include' })
      .then(r => r.json()).then(d => setSessions(d.data ?? [])).catch(() => {})
  }

  const restoreSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/ai/sessions/${sessionId}?source=debug`, { credentials: 'include' })
      const data = await res.json()
      setMessages((data.data ?? []).map((m: any) => ({ role: m.role, content: m.content })))
      sessionIdRef.current = sessionId
      setResult(null)
      setShowHistory(false)
    } catch {}
  }

  // La última sesión se mantiene: al entrar en la vista, se recupera sola sin
  // tener que ir a buscarla al historial.
  useEffect(() => {
    fetch('/api/ai/sessions?source=debug', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const last = (d.data ?? [])[0]
        if (last) restoreSession(last.sessionId)
      })
      .catch(() => {})
  }, [])

  // SSE logs
  useEffect(() => {
    const es = new EventSource('/api/ai/logs', { withCredentials: true })
    evtRef.current = es
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry
        if (entry.ns === 'AI') {
          setLogs(l => [...l.slice(-200), entry])
          setTimeout(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, 10)
        }
      } catch {}
    }
    return () => es.close()
  }, [])

  const send = useCallback(async () => {
    if (!input.trim() || loading) return
    const newMsgs: { role: 'user' | 'assistant'; content: string }[] = [
      ...messages,
      { role: 'user', content: input.trim() },
    ]
    setMessages(newMsgs)
    setInput('')
    setLoading(true)
    setError(null)
    setResult(null)
    if (!sessionIdRef.current) sessionIdRef.current = crypto.randomUUID()
    try {
      const res = await fetch('/api/ai/debug-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages: newMsgs, backend, sessionId: sessionIdRef.current }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error')
      setResult(data)
      if (data.finalText) {
        setMessages(m => [...m, { role: 'assistant', content: data.finalText }])
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [input, messages, loading, backend])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const levelColor = (level: string) => level === 'error' ? '#f87171' : 'var(--text)'

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>

      {/* Left: chat + result */}
      <div style={{ flex: '0 0 45%', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Debug Chatbot AI</h2>
          <select value={backend} onChange={e => setBackend(e.target.value as 'ollama' | 'claude')}
            style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)' }}>
            <option value="ollama">Ollama / RunPod</option>
            <option value="claude">Claude</option>
          </select>
          <button className="btn btn-ghost btn-xs" onClick={() => { setShowHistory(o => !o); if (!showHistory) loadSessions() }}>
            🕘 Sesiones
          </button>
          <button className="btn btn-ghost btn-xs" onClick={() => { setMessages([]); setResult(null); setError(null); sessionIdRef.current = null }}>
            Limpiar
          </button>
          {showHistory && (
            <div style={{
              position: 'absolute', top: '100%', left: 16, marginTop: 4, width: 320, maxHeight: 320, overflowY: 'auto',
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
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: m.role === 'user' ? 'var(--primary)' : 'var(--bg2)',
              color: m.role === 'user' ? '#fff' : 'var(--text)',
              borderRadius: 10, padding: '8px 12px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
            }}>
              <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 3, textTransform: 'uppercase' }}>{m.role}</div>
              {m.content}
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: 'flex-start', color: 'var(--text2)', fontSize: 13, fontStyle: 'italic' }}>
              Procesando…
            </div>
          )}
          {error && (
            <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8, padding: '8px 12px', color: '#f87171', fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Escribe un mensaje… (Enter para enviar)"
            style={{ flex: 1, resize: 'none', height: 60, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' }}
          />
          <button className="btn btn-primary btn-sm" onClick={send} disabled={loading || !input.trim()} style={{ alignSelf: 'flex-end' }}>
            {loading ? '…' : 'Enviar'}
          </button>
        </div>
      </div>

      {/* Right: iterations + logs */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Iterations */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Traza de ejecución</h3>
            {result && <span style={{ fontSize: 11, color: 'var(--text2)' }}>{result.backend} · {result.iterations.length} iteración{result.iterations.length !== 1 ? 'es' : ''}</span>}
          </div>
          {!result && !loading && (
            <div style={{ color: 'var(--text2)', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
              Envía un mensaje para ver la traza
            </div>
          )}
          {result?.iterations.map(iter => <IterationPanel key={iter.index} iter={iter} />)}
        </div>

        {/* Live logs */}
        <div style={{ flex: '0 0 auto', borderTop: '1px solid var(--border)', maxHeight: logsOpen ? 220 : 36, transition: 'max-height .2s', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div
            onClick={() => setLogsOpen(o => !o)}
            style={{ padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg2)', borderBottom: logsOpen ? '1px solid var(--border)' : 'none', userSelect: 'none', flexShrink: 0 }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>Logs SSE</span>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>{logs.length} entradas</span>
            <button className="btn btn-ghost btn-xs" style={{ marginLeft: 'auto' }} onClick={e => { e.stopPropagation(); setLogs([]) }}>Limpiar</button>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>{logsOpen ? '▼' : '▲'}</span>
          </div>
          {logsOpen && (
            <div ref={logRef} style={{ overflowY: 'auto', flex: 1, padding: '6px 10px', fontFamily: 'monospace', fontSize: 11 }}>
              {logs.length === 0 && <div style={{ color: 'var(--text2)', fontStyle: 'italic' }}>Sin logs aún…</div>}
              {logs.map((l, i) => (
                <div key={i} style={{ color: levelColor(l.level), marginBottom: 2, lineHeight: 1.5 }}>
                  <span style={{ opacity: 0.5 }}>{new Date(l.ts).toLocaleTimeString('es-ES')} </span>
                  <span style={{ color: '#a78bfa' }}>[{l.ns}] </span>
                  {l.msg}
                  {l.data && Object.keys(l.data).length > 0 && (
                    <span style={{ opacity: 0.6 }}> · {JSON.stringify(l.data).slice(0, 120)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
