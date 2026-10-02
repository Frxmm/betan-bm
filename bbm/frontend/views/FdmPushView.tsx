import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { rootRateOf } from '../lib/utils'

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

type PushMode = 'prices_only' | 'prices_and_avail'

interface PushResult {
  total:     number
  pushed:    number
  skipped:   number
  errors:    number
  errorList: string[]
  from:      string
  to:        string
  mode:      PushMode
}

export default function FdmPushView() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [rootName,   setRootName]   = useState<string>('raíz')
  useEffect(() => {
    api.listRates().then(r => { const t = rootRateOf(r.data as any[])?.title; if (t) setRootName(t) }).catch(() => {})
  }, [])
  const [from,       setFrom]       = useState(todayISO())
  const [to,         setTo]         = useState(addDays(todayISO(), 30))
  const [mode,       setMode]       = useState<PushMode>('prices_only')
  const [pushing,    setPushing]    = useState(false)
  const [result,     setResult]     = useState<PushResult | null>(null)
  const [error,      setError]      = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/fdm/status', { credentials: 'include' })
      .then(r => r.json())
      .then((r: any) => setConfigured(r.configured))
      .catch(() => setConfigured(false))
  }, [])

  async function runPush() {
    if (!from || !to || from > to) return
    setPushing(true); setResult(null); setError(null)
    try {
      const resp = await fetch('/api/fdm/push-prices', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ from, to, mode }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`)
      setResult(data.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPushing(false)
    }
  }

  const modeLabel = mode === 'prices_only' ? 'Solo precios' : 'Precios + disponibilidad'

  return (
    <div className="view-container" style={{ maxWidth: 680 }}>
      <div className="view-header">
        <div>
          <h2>Enviar tarifas a FDM</h2>
          <p className="view-subtitle">Publica los precios de la tarifa <strong>{rootName}</strong> en FrontDesk Master</p>
        </div>
        {configured === true  && <span className="badge badge-checkedin">Conectado</span>}
        {configured === false && <span className="badge badge-cancelled">Sin configurar</span>}
      </div>

      {configured === false && (
        <div className="card" style={{ marginBottom: 20, padding: '14px 18px', background: 'var(--yellow, #fef3c7)', border: '1px solid #f59e0b', borderRadius: 8, fontSize: 13 }}>
          Añade <code>FDM_USERNAME</code> y <code>FDM_PASSWORD</code> al fichero <code>.env</code> y reinicia el servidor.
        </div>
      )}

      {error && (
        <div className="alert-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        {/* Selector de modo */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content' }}>
          {(['prices_and_avail', 'prices_only'] as PushMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding:    '7px 16px',
                fontSize:   13,
                fontWeight: mode === m ? 600 : 400,
                background: mode === m ? 'var(--accent)' : 'transparent',
                color:      mode === m ? '#fff' : 'var(--text2)',
                border:     'none',
                cursor:     'pointer',
                transition: 'background .15s, color .15s',
              }}
            >
              {m === 'prices_and_avail' ? 'Precios + disponibilidad' : 'Solo precios'}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Desde</div>
            <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Hasta</div>
            <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <button
            className="btn btn-primary"
            onClick={runPush}
            disabled={pushing || !configured || !from || !to || from > to}
            style={{ height: 38 }}
          >
            {pushing ? 'Enviando…' : `Enviar →`}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => { setFrom(todayISO()); setTo(todayISO()) }}
            disabled={pushing || !configured}
            style={{ height: 38, fontSize: 12 }}
            title="Establecer rango = hoy"
          >
            Solo hoy
          </button>
        </div>

        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12, color: 'var(--text2)' }}>
          {mode === 'prices_and_avail'
            ? <>Llama a <code>pricingInfo</code> + <code>availability</code> + <code>setAvailability</code> por cada fecha, y finaliza con <code>setAvailabilityRange</code>.</>
            : <>Llama solo a <code>pricingInfo</code> por cada fecha, sin tocar la disponibilidad en FDM.</>
          }
        </p>
      </div>

      {result && (
        <div className="card">
          <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
            Resultado — {result.from} → {result.to}
            <span style={{ marginLeft: 10, fontWeight: 400, fontSize: 11, color: 'var(--text2)' }}>
              ({result.mode === 'prices_only' ? 'solo precios' : 'precios + disponibilidad'})
            </span>
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, marginBottom: result.errorList.length ? 12 : 0 }}>
            <span style={{ color: 'var(--text2)' }}>Total: <strong>{result.total}</strong></span>
            <span style={{ color: 'var(--green)' }}>✓ {result.pushed} enviadas</span>
            {result.skipped > 0 && <span style={{ color: 'var(--text2)' }}>⊘ {result.skipped} omitidas</span>}
            {result.errors  > 0 && <span style={{ color: 'var(--red)' }}>✕ {result.errors} errores</span>}
          </div>
          {result.errorList.length > 0 && (
            <div style={{ padding: '10px 12px', background: 'var(--bg2)', borderRadius: 6 }}>
              {result.errorList.map((e, i) => (
                <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--red)', marginTop: i > 0 ? 3 : 0 }}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
