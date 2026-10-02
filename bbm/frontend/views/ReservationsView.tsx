import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Rate } from '../lib/api'
import { fmtDate, fmtMoney, today, toast } from '../lib/utils'
import { Badge } from '../components/Badge'
import { Modal } from '../components/Modal'
import { useAuth, canManage } from '../contexts/AuthContext'

type SortDir = 'asc' | 'desc'

function SortTh({ col, cur, dir, onSort, children }: {
  col: string; cur: string; dir: SortDir; onSort: (c: string) => void; children: React.ReactNode
}) {
  const active = cur === col
  return (
    <th onClick={() => onSort(col)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {children}{' '}
      <span style={{ opacity: active ? 1 : 0.25, fontSize: 11 }}>{active ? (dir === 'asc' ? '↑' : '↓') : '↕'}</span>
    </th>
  )
}

// ─── Configuración de campos editables (solo admin) ───────────────────────────

const ROLES_OPTIONS = [
  { value: 'recepcion',     label: 'Recepción' },
  { value: 'conserje',      label: 'Conserje' },
  { value: 'mantenimiento', label: 'Mantenimiento' },
  { value: 'limpieza',      label: 'Limpieza' },
  { value: 'cocina',        label: 'Cocina' },
]

function FieldRulesConfig() {
  const [rules,    setRules]    = useState<any[]>([])
  const [channels, setChannels] = useState<any[]>([])
  const [saving,   setSaving]   = useState(false)
  const [dirty,    setDirty]    = useState(false)

  useEffect(() => {
    Promise.all([
      api.getFieldRules().then((r: any)   => setRules(r.data ?? [])),
      api.listChannels().then((r: any) => setChannels(r.data ?? [])),
    ]).catch(() => {})
  }, [])

  const toggleRole = (fieldKey: string, role: string) => {
    setRules(prev => prev.map(r => {
      if (r.fieldKey !== fieldKey) return r
      const roles: string[] = r.allowedRoles ?? []
      return { ...r, allowedRoles: roles.includes(role) ? roles.filter(x => x !== role) : [...roles, role] }
    }))
    setDirty(true)
  }

  const toggleChannel = (fieldKey: string, channelId: number) => {
    setRules(prev => prev.map(r => {
      if (r.fieldKey !== fieldKey) return r
      const ids: number[] = r.allowedChannelIds ?? []
      return { ...r, allowedChannelIds: ids.includes(channelId) ? ids.filter(x => x !== channelId) : [...ids, channelId] }
    }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.updateFieldRules(rules.map(r => ({
        fieldKey: r.fieldKey,
        allowedRoles: r.allowedRoles ?? [],
        allowedChannelIds: r.allowedChannelIds ?? [],
      })))
      toast('Configuración guardada')
      setDirty(false)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  if (!rules.length) return <div className="loading">Cargando…</div>

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <div className="card-header">
        <h2>Campos editables en reservas</h2>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
      <p style={{ padding: '8px 18px 4px', fontSize: 13, color: 'var(--text2)' }}>
        Dirección y admin pueden editar siempre. Configura qué otros roles y canales tienen acceso.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 160 }}>Campo</th>
            <th>Roles adicionales permitidos</th>
            <th>Restringir a canales (vacío = todos)</th>
          </tr>
        </thead>
        <tbody>
          {rules.map(rule => (
            <tr key={rule.fieldKey}>
              <td><strong style={{ fontSize: 13 }}>{rule.label}</strong><br /><code style={{ fontSize: 11, color: 'var(--text2)' }}>{rule.fieldKey}</code></td>
              <td>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
                  {ROLES_OPTIONS.map(opt => (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={(rule.allowedRoles ?? []).includes(opt.value)}
                        onChange={() => toggleRole(rule.fieldKey, opt.value)}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
                  {channels.map((ch: any) => (
                    <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={(rule.allowedChannelIds ?? []).includes(ch.id)}
                        onChange={() => toggleChannel(rule.fieldKey, ch.id)}
                      />
                      {ch.name}
                    </label>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Nombres/apellidos bloqueados al guardar un huésped (solo admin) ──────────

function BlockedGuestNamesConfig() {
  const [names,   setNames]   = useState<string[]>([])
  const [loaded,  setLoaded]  = useState(false)
  const [draft,   setDraft]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [dirty,   setDirty]   = useState(false)

  useEffect(() => {
    api.getBlockedGuestNames().then((r: any) => setNames(r.data ?? [])).finally(() => setLoaded(true)).catch(() => setLoaded(true))
  }, [])

  const addName = () => {
    const v = draft.trim()
    if (!v) return
    if (names.some(n => n.toLowerCase() === v.toLowerCase())) { setDraft(''); return }
    setNames(prev => [...prev, v])
    setDraft('')
    setDirty(true)
  }

  const removeName = (v: string) => {
    setNames(prev => prev.filter(n => n !== v))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const r: any = await api.updateBlockedGuestNames(names)
      setNames(r.data ?? names)
      toast('Configuración guardada')
      setDirty(false)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  if (!loaded) return <div className="loading">Cargando…</div>

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
      <div className="card-header">
        <h2>Nombres bloqueados al guardar huéspedes</h2>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
      <p style={{ padding: '8px 18px 4px', fontSize: 13, color: 'var(--text2)' }}>
        Si el nombre, apellido o segundo apellido de un huésped coincide exactamente con alguno de esta lista
        (sin distinguir mayúsculas ni acentos), no se podrá guardar. Útil para evitar placeholders como
        "Recepción", "Hotel" o el nombre del propio hotel tecleados por error en vez del nombre real del cliente.
      </p>
      <div style={{ padding: '4px 18px 18px' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="form-input"
            value={draft}
            placeholder="Añadir nombre o apellido bloqueado…"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addName() } }}
            style={{ flex: 1 }}
          />
          <button className="btn btn-ghost btn-sm" onClick={addName} disabled={!draft.trim()}>+ Añadir</button>
        </div>
        {names.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text2)' }}>Sin nombres bloqueados.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {names.map(n => (
              <span key={n} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                borderRadius: 14, background: 'var(--bg3)', fontSize: 13,
              }}>
                {n}
                <button
                  onClick={() => removeName(n)}
                  title={`Quitar "${n}"`}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', fontSize: 14, lineHeight: 1, padding: 0 }}
                >×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── "Debe estar saldada para check-in" (código de puerta TTLock) ────────────
// Regla de negocio: por defecto, una reserva no puede generar/(re)enviar el
// código de acceso TTLock si tiene saldo pendiente (ver src/routes/ttlock.ts).
// Aquí se marcan los canales de venta EXENTOS de esa regla — sus reservas
// pueden entrar sin estar saldadas (p.ej. canales que cobran ellos aparte).

function TtlockBalanceExemptConfig() {
  const [channels,  setChannels]  = useState<any[]>([])
  const [exemptIds, setExemptIds] = useState<number[]>([])
  const [loaded,    setLoaded]    = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [dirty,     setDirty]     = useState(false)

  useEffect(() => {
    Promise.all([
      api.listChannels().then((r: any) => setChannels(r.data ?? [])),
      api.getTtlockBalanceExemptChannels().then((r: any) => setExemptIds(r.data ?? [])),
    ]).finally(() => setLoaded(true)).catch(() => setLoaded(true))
  }, [])

  const toggle = (channelId: number) => {
    setExemptIds(prev => prev.includes(channelId) ? prev.filter(id => id !== channelId) : [...prev, channelId])
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const r: any = await api.updateTtlockBalanceExemptChannels(exemptIds)
      setExemptIds(r.data ?? exemptIds)
      toast('Configuración guardada')
      setDirty(false)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  if (!loaded) return <div className="loading">Cargando…</div>

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
      <div className="card-header">
        <h2>Debe estar saldada para check-in</h2>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </div>
      <p style={{ padding: '8px 18px 4px', fontSize: 13, color: 'var(--text2)' }}>
        Por defecto, una reserva con saldo pendiente no puede generar ni (re)enviar el código de acceso
        TTLock. Marca los canales de venta que quedan exentos de esta regla (p.ej. canales que cobran
        ellos aparte) — sus reservas podrán entrar sin estar saldadas.
      </p>
      <div style={{ padding: '4px 18px 18px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
        {channels.map((ch: any) => (
          <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={exemptIds.includes(ch.id)} onChange={() => toggle(ch.id)} />
            {ch.name}
          </label>
        ))}
      </div>
    </div>
  )
}

// ─── Vista principal ───────────────────────────────────────────────────────────

const SS = 'rv_'
function ssGet(k: string, def: string) { try { return sessionStorage.getItem(SS + k) ?? def } catch { return def } }
function ssSave(vals: Record<string, string>) { try { for (const [k, v] of Object.entries(vals)) sessionStorage.setItem(SS + k, v) } catch { /* silencioso */ } }

export default function ReservationsView() {
  const { user } = useAuth()
  const isAdmin  = canManage(user)
  const [activeTab, setActiveTab] = useState<'list' | 'config'>(() => (ssGet('tab', 'list') as 'list' | 'config'))
  const navigate = useNavigate()
  const [status,    setStatus]    = useState(() => ssGet('status', ''))
  const [dateType,  setDateType]  = useState<'checkIn' | 'checkOut' | 'createdAt' | 'stayDate'>(() => ssGet('dateType', 'checkIn') as any)
  const [dateFrom,  setDateFrom]  = useState(() => ssGet('dateFrom', today()))
  const [dateTo,    setDateTo]    = useState(() => ssGet('dateTo',   today()))
  const [rateId,    setRateId]    = useState(() => ssGet('rateId',   ''))
  const [channelId, setChannelId] = useState(() => ssGet('channelId', ''))
  const [hasExtraRooms, setHasExtraRooms] = useState(() => ssGet('hasExtraRooms', '') === '1')
  const [page,      setPage]      = useState(() => Number(ssGet('page', '1')))
  const [pageSize,  setPageSize]  = useState(() => Number(ssGet('pageSize', '50')))
  const [data,      setData]      = useState<any[]>([])
  const [meta,      setMeta]      = useState<any>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [showNew,   setShowNew]   = useState(false)
  const [sortCol,   setSortCol]   = useState(() => ssGet('sortCol', 'status'))
  const [sortDir,   setSortDir]   = useState<SortDir>(() => ssGet('sortDir', 'asc') as SortDir)
  const [rateList,    setRateList]    = useState<any[]>([])
  const [channelList, setChannelList] = useState<any[]>([])

  useEffect(() => {
    ssSave({ tab: activeTab, status, dateType, dateFrom, dateTo, rateId, channelId, hasExtraRooms: hasExtraRooms ? '1' : '', page: String(page), pageSize: String(pageSize), sortCol, sortDir })
  }, [activeTab, status, dateType, dateFrom, dateTo, rateId, channelId, hasExtraRooms, page, pageSize, sortCol, sortDir])

  useEffect(() => {
    api.listRates().then((r: any) => setRateList(r.data ?? [])).catch(() => {})
    api.listChannels().then((r: any) => setChannelList(r.data ?? [])).catch(() => {})
  }, [])

  // El orden lo aplica el servidor (sobre TODas las filas que cumplen el
  // filtro, no solo la página cargada) — por eso sortCol/sortDir van en los
  // params en vez de reordenar `data` en el cliente.
  const load = useCallback(async (p: number) => {
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { page: String(p), limit: String(pageSize), sortCol, sortDir }
      if (status)    params.status    = status
      if (dateType)  params.dateType  = dateType
      if (dateFrom)  params.dateFrom  = dateFrom
      if (dateTo)    params.dateTo    = dateTo
      if (rateId)    params.rateId    = rateId
      if (channelId) params.channelId = channelId
      if (hasExtraRooms) params.hasExtraRooms = '1'
      const res: any = await api.listReservations(params)
      setData(res.data); setMeta(res.meta ?? null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [status, dateType, dateFrom, dateTo, rateId, channelId, hasExtraRooms, pageSize, sortCol, sortDir])

  useEffect(() => { setPage(1); load(1) }, [status, dateType, dateFrom, dateTo, rateId, channelId, hasExtraRooms, pageSize, sortCol, sortDir]) // eslint-disable-line
  useEffect(() => { load(page) }, [page])                  // eslint-disable-line

  const onSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const exportCsv = async () => {
    // Descarga TODOS los registros con los filtros actuales, paginando —
    // limit tiene un tope de 1000 en el servidor, así que si hay más hace
    // falta más de una página (antes se pedía limit=9999 de golpe, por
    // encima del tope, y el servidor lo rechazaba).
    const baseParams: Record<string, string> = { limit: '1000', sortCol, sortDir }
    if (status)    baseParams.status    = status
    if (dateType)  baseParams.dateType  = dateType
    if (dateFrom)  baseParams.dateFrom  = dateFrom
    if (dateTo)    baseParams.dateTo    = dateTo
    if (rateId)    baseParams.rateId    = rateId
    if (channelId) baseParams.channelId = channelId
    if (hasExtraRooms) baseParams.hasExtraRooms = '1'

    const rows: any[] = []
    for (let p = 1; ; p++) {
      const res: any = await api.listReservations({ ...baseParams, page: String(p) })
      rows.push(...res.data)
      if (rows.length >= (res.meta?.total ?? rows.length) || res.data.length === 0) break
    }

    const STATUS_LABEL: Record<string, string> = {
      tentative: 'Provisional', arriving: 'Por llegar', confirmed: 'Confirmada', checked_in: 'En casa',
      checking_out: 'Saliendo', checked_out: 'Ha salido', no_show: 'No show', cancelled: 'Cancelada',
    }
    const esc = (v: any) => {
      const s = String(v ?? '')
      return s.includes(';') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }

    const headers = ['Código','Huésped','Habitación','Llegada','Salida','Noches','Personas','Fecha reserva','Tarifa','Operador','Total','Estado']
    const lines = [headers.join(';')]
    for (const r of rows) {
      lines.push([
        r.externalCode ?? r.id,
        `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
        [r.room?.code, ...(r.extraRoomCodes ?? [])].filter(Boolean).join(' + '),
        r.checkInDate ?? '',
        r.checkOutDate ?? '',
        r.nights ?? '',
        r.people ?? 1,
        r.createdAt ? r.createdAt.slice(0, 10) : '',
        r.rate?.title ?? '',
        r.bookingChannel?.name ?? '',
        String(r.total ?? '').replace('.', ','),
        STATUS_LABEL[r.status] ?? r.status,
      ].map(esc).join(';'))
    }

    // BOM UTF-8 para que Excel reconozca la codificación
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `reservas_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sorted = data   // ya viene ordenado del servidor

  return (
    <>
      {isAdmin && (
        <div className="hk-tabs" style={{ marginBottom: 0 }}>
          <button className={`hk-tab${activeTab === 'list'   ? ' active' : ''}`} onClick={() => setActiveTab('list')}>Reservas</button>
          <button className={`hk-tab${activeTab === 'config' ? ' active' : ''}`} onClick={() => setActiveTab('config')}>Configuración</button>
        </div>
      )}

      {activeTab === 'config' && isAdmin && <>
        <FieldRulesConfig />
        <BlockedGuestNamesConfig />
        <TtlockBalanceExemptConfig />
      </>}

      {activeTab === 'list' && <>
      <div className="search-bar" style={{ flexWrap: 'wrap', gap: '8px 6px' }}>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          <option value="arriving">Por llegar</option>
          <option value="tentative">Provisional</option>
          <option value="confirmed">Confirmadas</option>
          <option value="checked_in">En casa</option>
          <option value="checking_out">Saliendo</option>
          <option value="checked_out">Han salido</option>
          <option value="cancelled">Canceladas</option>
          <option value="no_show">No show</option>
        </select>
        <select value={rateId} onChange={e => setRateId(e.target.value)}>
          <option value="">Todas las tarifas</option>
          {rateList.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <select value={channelId} onChange={e => setChannelId(e.target.value)}>
          <option value="">Todos los operadores</option>
          {channelList.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={dateType} onChange={e => setDateType(e.target.value as any)}>
          <option value="checkIn">Llegada</option>
          <option value="checkOut">Salida</option>
          <option value="createdAt">Reservada</option>
          <option value="stayDate">Estadía</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} title="Desde" style={{ width: 140 }} />
        <span style={{ alignSelf: 'center', color: 'var(--text2)', fontSize: 13 }}>—</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} title="Hasta" style={{ width: 140 }} />
        {isAdmin && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text2)', cursor: 'pointer' }}
            title="Reservas con habitaciones adicionales asignadas">
            <input type="checkbox" checked={hasExtraRooms} onChange={e => setHasExtraRooms(e.target.checked)} style={{ width: 15, height: 15 }} />
            Con habs. adicionales
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text2)' }}>
          Por página:
          <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }} style={{ width: 80 }}>
            {[25, 50, 100, 200, 500, 1000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn btn-ghost btn-sm" onClick={() => { setStatus(''); setRateId(''); setChannelId(''); setHasExtraRooms(false); setDateFrom(today()); setDateTo(today()) }}
          title="Limpiar filtros">✕ Hoy</button>
        <button className="btn btn-ghost btn-sm" onClick={exportCsv} title="Exportar a Excel/CSV" style={{ marginLeft: 'auto' }}>⬇ Exportar</button>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ Nueva reserva</button>
      </div>

      {loading && <div className="loading">Cargando…</div>}
      {error   && <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>}
      {!loading && !error && data.length === 0 && (
        <div className="empty"><div className="icon">📭</div><p>Sin reservas</p></div>
      )}
      {!loading && !error && data.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>Reservas <span style={{ color: 'var(--text2)', fontWeight: 400 }}>({meta?.total ?? data.length})</span></h2>
          </div>
          <table>
            <thead><tr>
              <SortTh col="code"     cur={sortCol} dir={sortDir} onSort={onSort}>Código</SortTh>
              <SortTh col="guest"    cur={sortCol} dir={sortDir} onSort={onSort}>Huésped</SortTh>
              <SortTh col="room"     cur={sortCol} dir={sortDir} onSort={onSort}>Habitación</SortTh>
              <SortTh col="checkIn"  cur={sortCol} dir={sortDir} onSort={onSort}>Llegada</SortTh>
              <SortTh col="checkOut" cur={sortCol} dir={sortDir} onSort={onSort}>Salida</SortTh>
              <SortTh col="nights"    cur={sortCol} dir={sortDir} onSort={onSort}>Noches</SortTh>
              <SortTh col="people"    cur={sortCol} dir={sortDir} onSort={onSort}>Personas</SortTh>
              <SortTh col="createdAt" cur={sortCol} dir={sortDir} onSort={onSort}>Fecha reserva</SortTh>
              <SortTh col="rate"      cur={sortCol} dir={sortDir} onSort={onSort}>Tarifa</SortTh>
              <SortTh col="channel"  cur={sortCol} dir={sortDir} onSort={onSort}>Operador</SortTh>
              <SortTh col="total"    cur={sortCol} dir={sortDir} onSort={onSort}>Total</SortTh>
              <SortTh col="pending"  cur={sortCol} dir={sortDir} onSort={onSort}>Pendiente</SortTh>
              <SortTh col="status"   cur={sortCol} dir={sortDir} onSort={onSort}>Estado</SortTh>
            </tr></thead>
            <tbody>
              {sorted.map((r: any) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/reservations/${r.id}`)}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.externalCode ?? r.id}</td>
                  <td><strong>{r.guest?.firstName} {r.guest?.lastName}</strong></td>
                  <td>
                    {r.room?.code ?? '—'}
                    {r.extraRoomCodes?.length > 0 && (
                      <span style={{ color: 'var(--text2)', fontSize: 12 }}> + {r.extraRoomCodes.join(', ')}</span>
                    )}
                  </td>
                  <td>{fmtDate(r.checkInDate)}</td>
                  <td>{fmtDate(r.checkOutDate)}</td>
                  <td>{r.nights}</td>
                  <td>{r.people ?? 1}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{r.createdAt ? fmtDate(r.createdAt) : '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.rate?.title ?? '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.bookingChannel?.name ?? '—'}</td>
                  <td>{fmtMoney(r.total)}</td>
                  <td>
                    {(() => {
                      const p = r.pendingBalance ?? 0
                      const isDebt = p > 0
                      return (
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 7px',
                          borderRadius: 5,
                          fontSize: 12,
                          fontWeight: 600,
                          background: isDebt ? 'var(--red, #b91c1c)' : '#15803d',
                          color: '#fff',
                        }}>
                          {fmtMoney(p)}
                        </span>
                      )
                    })()}
                  </td>
                  <td><Badge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {meta && meta.total > pageSize && (
            <div style={{ padding: '12px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', borderTop: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text2)', fontSize: 13, marginRight: 'auto' }}>
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, meta.total)} de {meta.total}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Anterior</button>
              <span style={{ padding: '4px 8px', color: 'var(--text2)', fontSize: 13 }}>Página {page} / {Math.ceil(meta.total / pageSize)}</span>
              <button className="btn btn-ghost btn-sm" disabled={page * pageSize >= meta.total} onClick={() => setPage(p => p + 1)}>Siguiente →</button>
            </div>
          )}
        </div>
      )}

      {showNew && (
        <NewReservationModal
          onClose={() => setShowNew(false)}
          onCreated={id => { setShowNew(false); navigate(`/reservations/${id}`) }}
        />
      )}
      </>}
    </>
  )
}

function NewReservationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [rooms,    setRooms]    = useState<any[]>([])
  const [rates,    setRates]    = useState<Rate[]>([])
  const [channels, setChannels] = useState<any[]>([])
  const [form, setForm] = useState({ roomId: '', checkIn: '', checkOut: '', people: '1', rateId: '', channelId: '', code: '' })
  const [saving, setSaving] = useState(false)
  const [calcPrice, setCalcPrice] = useState<{ total: number; nights: number; missing: number } | null>(null)
  const [manualTotal, setManualTotal] = useState('')

  // Guest autocomplete
  const [guestQ,        setGuestQ]        = useState('')
  const [guestResults,  setGuestResults]  = useState<any[]>([])
  const [selectedGuest, setSelectedGuest] = useState<{ id: number; label: string; email?: string } | null>(null)
  const [showNewGuest,  setShowNewGuest]  = useState(false)
  const [gFn, setGFn] = useState(''), [gLn, setGLn] = useState('')
  const [gPh, setGPh] = useState(''), [gEm, setGEm] = useState('')
  const [sendConf, setSendConf] = useState(true)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    Promise.all([
      api.listRooms().then((r: any) => setRooms(r.data)),
      api.listRates().then((r: any) => setRates(r.data)),
      api.listChannels().then((r: any) => setChannels(r.data)),
    ]).catch(() => {})
  }, [])

  // Calcular precio cuando hay tarifa + habitación + fechas
  useEffect(() => {
    if (!form.rateId || !form.roomId || !form.checkIn || !form.checkOut) {
      setCalcPrice(null); return
    }
    const params = new URLSearchParams({ roomId: form.roomId, rateId: form.rateId, checkIn: form.checkIn, checkOut: form.checkOut })
    fetch(`/api/reservations/calc-price?${params}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.total !== undefined) setCalcPrice({ total: d.total, nights: d.nights, missing: d.missingDates }) })
      .catch(() => {})
  }, [form.rateId, form.roomId, form.checkIn, form.checkOut])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const onGuestSearch = (q: string) => {
    setGuestQ(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (q.length < 2) { setGuestResults([]); return }
    searchTimer.current = setTimeout(async () => {
      try { const r: any = await api.listGuests({ q, limit: '100' }); setGuestResults(r.data) }
      catch { setGuestResults([]) }
    }, 280)
  }

  const pickGuest = (g: any) => {
    setSelectedGuest({ id: g.id, label: `${g.firstName} ${g.lastName}${g.email ? ' — ' + g.email : ''}`, email: g.email || undefined })
    setGuestResults([])
  }

  const createAndPickGuest = async () => {
    if (!gFn.trim() || !gLn.trim()) { toast('Nombre y apellidos obligatorios', 'err'); return }
    try {
      const r: any = await api.createGuest({ firstName: gFn.trim(), lastName: gLn.trim(),
        phone: gPh.trim() || undefined, email: gEm.trim() || undefined })
      const g = r.data
      setSelectedGuest({ id: g.id, label: `${g.firstName} ${g.lastName}${g.email ? ' — ' + g.email : ''}`, email: g.email || undefined })
      setShowNewGuest(false); toast('Huésped creado')
    } catch (e: any) { toast(e.message, 'err') }
  }

  const effectiveTotal = manualTotal !== '' ? parseFloat(manualTotal) || 0 : (calcPrice?.total ?? 0)

  const save = async () => {
    if (!selectedGuest || !form.roomId || !form.checkIn || !form.checkOut) { toast('Completa los campos obligatorios', 'err'); return }
    if (!form.rateId)    { toast('Selecciona una tarifa', 'err'); return }
    if (!form.channelId) { toast('Selecciona un canal de reserva', 'err'); return }
    if (effectiveTotal <= 0) { toast('El total debe ser mayor de 0 €', 'err'); return }
    setSaving(true)
    try {
      const res: any = await api.createReservation({
        guestId: selectedGuest.id, roomId: Number(form.roomId),
        checkInDate: form.checkIn, checkOutDate: form.checkOut,
        people: Number(form.people),
        rateId: Number(form.rateId),
        bookingChannelId: Number(form.channelId),
        externalCode: form.code || undefined,
        total: effectiveTotal,
      })
      if (sendConf && selectedGuest.email) {
        api.sendConfirmation(res.data.id).catch(() => {})
      }
      toast('Reserva creada'); onCreated(res.data.id)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Nueva reserva" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Crear reserva</button></>
    }>
      <div className="form-grid">
        <div className="form-group full">
          <label>Huésped *</label>
          {selectedGuest ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{selectedGuest.label}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedGuest(null)}>✕</button>
            </div>
          ) : (
            <div className="guest-search-wrap">
              <input type="text" className="guest-search-input" placeholder="Buscar por nombre, email o DNI…"
                value={guestQ} onChange={e => onGuestSearch(e.target.value)} autoComplete="off" />
              {guestResults.length > 0 && (
                <div className="guest-results">
                  {guestResults.map((g: any) => (
                    <div key={g.id} className="guest-result-item" onClick={() => pickGuest(g)}>
                      {g.firstName} {g.lastName}{g.email ? ` — ${g.email}` : ''}
                      {g.idDocNumber ? <span style={{ color: 'var(--text2)', fontSize: 11, marginLeft: 6 }}>{g.idDocNumber}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
            onClick={() => setShowNewGuest(v => !v)}>+ Nuevo huésped</button>
          {showNewGuest && (
            <div style={{ marginTop: 8, background: 'var(--bg2)', borderRadius: 8, padding: 12 }}>
              <div className="form-grid" style={{ gap: 8 }}>
                <div className="form-group"><label>Nombre *</label><input value={gFn} onChange={e => setGFn(e.target.value)} /></div>
                <div className="form-group"><label>Apellidos *</label><input value={gLn} onChange={e => setGLn(e.target.value)} /></div>
                <div className="form-group"><label>Teléfono</label><input value={gPh} onChange={e => setGPh(e.target.value)} /></div>
                <div className="form-group"><label>Email</label><input type="email" value={gEm} onChange={e => setGEm(e.target.value)} /></div>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={createAndPickGuest}>Crear y seleccionar</button>
            </div>
          )}
        </div>
        <div className="form-group">
          <label>Habitación *</label>
          <select value={form.roomId} onChange={set('roomId')}>
            <option value="">Seleccionar…</option>
            {rooms.map((r: any) => <option key={r.id} value={r.id}>{r.code} — {r.roomType?.name ?? ''}</option>)}
          </select>
        </div>
        <div className="form-group"><label>Fecha de entrada *</label><input type="date" value={form.checkIn} onChange={set('checkIn')} /></div>
        <div className="form-group"><label>Fecha de salida *</label><input type="date" value={form.checkOut} onChange={set('checkOut')} /></div>
        <div className="form-group"><label>Personas</label><input type="number" value={form.people} onChange={set('people')} min={1} max={10} /></div>
        <div className="form-group">
          <label>Tarifa *</label>
          <select value={form.rateId} onChange={set('rateId')}>
            <option value="">Seleccionar…</option>
            {rates.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Canal *</label>
          <select value={form.channelId} onChange={set('channelId')}>
            <option value="">Seleccionar…</option>
            {channels.map((ch: any) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
          </select>
        </div>
        <div className="form-group full">
          <label>
            Total
            {calcPrice && (
              <span style={{ fontWeight: 400, color: 'var(--text2)', fontSize: 12, marginLeft: 8 }}>
                calculado: {calcPrice.total.toFixed(2)} €
                {calcPrice.missing > 0 && ` (faltan ${calcPrice.missing} noches sin precio)`}
              </span>
            )}
          </label>
          <input
            type="number" step="0.01" min="0"
            value={manualTotal !== '' ? manualTotal : (calcPrice?.total.toFixed(2) ?? '')}
            onChange={e => setManualTotal(e.target.value)}
            placeholder={calcPrice ? calcPrice.total.toFixed(2) : '0.00'}
          />
          {manualTotal !== '' && calcPrice && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 4 }}
              onClick={() => setManualTotal('')}>
              Usar precio calculado ({calcPrice.total.toFixed(2)} €)
            </button>
          )}
        </div>
        <div className="form-group full">
          <label>Código externo</label>
          <input type="text" value={form.code} onChange={set('code')} placeholder="Booking.com, Airbnb…" />
        </div>
        {selectedGuest?.email && (
          <div className="form-group full">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={sendConf} onChange={e => setSendConf(e.target.checked)} style={{ width: 15, height: 15 }} />
              Enviar confirmación por email al huésped
              <span style={{ color: 'var(--text2)', fontWeight: 400, fontSize: 12 }}>({selectedGuest.email})</span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}
