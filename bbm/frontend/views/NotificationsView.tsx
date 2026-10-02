import { useState, useEffect } from 'react'
import { toast } from '../lib/utils'

// ─── Administración de notificaciones (solo dirección) ─────────────────────────
// Qué mensaje sale por qué canal, exclusiones por canal de venta, y plantillas.

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch('/api/settings' + path, {
    method, credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
  return d
}

// ─── Matriz mensajes × canales ─────────────────────────────────────────────────

function ChannelMatrix() {
  const [rows,     setRows]     = useState<any[]>([])
  const [channels, setChannels] = useState<{ id: number; name: string }[]>([])
  const [loading,  setLoading]  = useState(true)

  const load = async () => {
    try {
      const d = await req('GET', '/messages')
      setRows(d.data); setChannels(d.channels ?? [])
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const save = async (row: any) => {
    try {
      await req('PUT', '/messages', {
        key: row.key, email: row.email, whatsapp: row.whatsapp,
        excludedChannelIds: row.excludedChannelIds,
      })
      toast('Guardado')
    } catch (e: any) { toast(e.message, 'err'); load() }
  }

  const toggle = (row: any, channel: 'email' | 'whatsapp') => {
    const next = { ...row, [channel]: !row[channel] }
    setRows(rs => rs.map(r => r.key === row.key ? next : r))
    save(next)
  }

  const toggleExclusion = (row: any, channelId: number) => {
    const ex   = row.excludedChannelIds.includes(channelId)
      ? row.excludedChannelIds.filter((id: number) => id !== channelId)
      : [...row.excludedChannelIds, channelId]
    const next = { ...row, excludedChannelIds: ex }
    setRows(rs => rs.map(r => r.key === row.key ? next : r))
    save(next)
  }

  if (loading) return <p>Cargando…</p>

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Canales de envío</h3>
      <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 12px' }}>
        Activa/desactiva cada canal por mensaje. En "No enviar a" marca los canales de venta cuyas
        reservas NO deben recibir ese mensaje (p.ej. pagos a reservas de Booking).
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>Mensaje</th>
              <th style={{ textAlign: 'center', width: 80 }}>✉️ Email</th>
              <th style={{ textAlign: 'center', width: 90 }}>📲 WhatsApp</th>
              <th>No enviar a reservas de…</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key}>
                <td style={{ fontWeight: 600 }}>{row.label}</td>
                {(['email', 'whatsapp'] as const).map(ch => (
                  <td key={ch} style={{ textAlign: 'center' }}>
                    {row[`${ch}Available`] ? (
                      <input type="checkbox" checked={row[ch]} onChange={() => toggle(row, ch)}
                        style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--accent)' }} />
                    ) : <span style={{ color: 'var(--text2)' }}>—</span>}
                  </td>
                ))}
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {channels.map(ch => {
                      const excluded = row.excludedChannelIds.includes(ch.id)
                      return (
                        <button key={ch.id} onClick={() => toggleExclusion(row, ch.id)}
                          title={excluded ? 'Excluido — clic para permitir' : 'Clic para excluir'}
                          style={{
                            fontSize: 11, padding: '3px 8px', borderRadius: 12, cursor: 'pointer',
                            border: `1px solid ${excluded ? 'var(--red)' : 'var(--border)'}`,
                            background: excluded ? 'rgba(239,68,68,.12)' : 'transparent',
                            color: excluded ? 'var(--red)' : 'var(--text2)',
                            textDecoration: excluded ? 'line-through' : 'none',
                          }}>
                          {ch.name}
                        </button>
                      )
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Plantillas de email ───────────────────────────────────────────────────────

function TemplateEditor() {
  const [templates, setTemplates] = useState<any[]>([])
  const [open,      setOpen]      = useState<string | null>(null)
  const [drafts,    setDrafts]    = useState<Record<string, { subject: string; html: string }>>({})
  const [preview,   setPreview]   = useState<string | null>(null)

  const load = async () => {
    try {
      const d = await req('GET', '/message-templates')
      setTemplates(d.data)
      setDrafts(Object.fromEntries(d.data.map((t: any) => [t.key, { subject: t.subject, html: t.html }])))
    } catch (e: any) { toast(e.message, 'err') }
  }
  useEffect(() => { load() }, [])

  const save = async (key: string) => {
    try {
      await req('PUT', '/message-templates', { key, ...drafts[key] })
      toast('Plantilla guardada')
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const restore = async (key: string) => {
    if (!confirm('¿Restaurar la plantilla de fábrica? Se perderán tus cambios.')) return
    try {
      await req('DELETE', `/message-templates/${key}`)
      toast('Plantilla restaurada')
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Plantillas de email</h3>
      <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 12px' }}>
        Edita el asunto y el HTML. Las variables <code>{'{{asi}}'}</code> se sustituyen al enviar.
      </p>
      {templates.map(t => (
        <div key={t.key} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
            onClick={() => setOpen(open === t.key ? null : t.key)}>
            <span style={{ fontSize: 13 }}>{open === t.key ? '▾' : '▸'}</span>
            <strong style={{ fontSize: 13, flex: 1 }}>{t.subject}</strong>
            {t.custom && <span className="badge" style={{ fontSize: 10, background: 'var(--accent)', color: '#fff' }}>personalizada</span>}
          </div>
          {open === t.key && drafts[t.key] && (() => { const draft = drafts[t.key]!; return (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                Variables: {t.vars.map((v: string) => <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>)}
              </div>
              <input value={draft.subject}
                onChange={e => setDrafts(d => ({ ...d, [t.key]: { ...d[t.key]!, subject: e.target.value } }))}
                placeholder="Asunto" />
              <textarea rows={12} value={draft.html} spellCheck={false}
                onChange={e => setDrafts(d => ({ ...d, [t.key]: { ...d[t.key]!, html: e.target.value } }))}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => save(t.key)}>Guardar</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setPreview(preview === t.key ? null : t.key)}>
                  {preview === t.key ? 'Ocultar vista previa' : 'Vista previa'}
                </button>
                {t.custom && (
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => restore(t.key)}>
                    Restaurar de fábrica
                  </button>
                )}
              </div>
              {preview === t.key && (
                <iframe srcDoc={draft.html} title="preview"
                  style={{ width: '100%', height: 380, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
              )}
            </div>
          )})()}
        </div>
      ))}
    </div>
  )
}

// ─── Plantillas WhatsApp (informativas — se editan en Meta) ────────────────────

// Catálogo que sirve el backend (GET /api/whatsapp/templates): nombres reales del tenant.
interface WaTemplate { key: string; name: string; description: string; variables: string[] }

export default function NotificationsView() {
  const [waTemplates, setWaTemplates] = useState<WaTemplate[]>([])
  useEffect(() => {
    fetch('/api/whatsapp/templates', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { data: [] })
      .then(d => setWaTemplates(d.data ?? []))
      .catch(() => {})
  }, [])
  return (
    <div style={{ padding: '16px 20px', maxWidth: 1000 }}>
      <h2 style={{ margin: '0 0 4px' }}>🔔 Notificaciones</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text2)' }}>
        Control central de los mensajes al cliente: canales, exclusiones y plantillas.
      </p>
      <ChannelMatrix />
      <TemplateEditor />
      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Plantillas de WhatsApp</h3>
        <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 10px' }}>
          Las plantillas de WhatsApp las aprueba y aloja Meta — se editan en
          {' '}<a href="https://business.facebook.com/wa/manage/message-templates" target="_blank" rel="noreferrer">WhatsApp Manager</a>.
          El sistema usa estos nombres (idioma <code>es</code>):
        </p>
        <table className="table" style={{ fontSize: 13 }}>
          <tbody>
            {waTemplates.length === 0 && (
              <tr><td style={{ color: 'var(--text2)' }}>Sin plantillas (WhatsApp no activado para este hotel)</td></tr>
            )}
            {waTemplates.map(t => (
              <tr key={t.key}>
                <td><code>{t.name}</code></td>
                <td style={{ color: 'var(--text2)' }}>
                  {t.description}
                  {t.variables?.length > 0 && <> · variables: {t.variables.map(v => <code key={v} style={{ marginRight: 4 }}>{v}</code>)}</>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
