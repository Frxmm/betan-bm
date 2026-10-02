import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { toast, fmtDateTime, fmtMoney, STATUS_LABEL, STATUS_COLOR } from '../lib/utils'
import { useAuth, canManage, canManageReservations } from '../contexts/AuthContext'

const PRICING_LABELS: Record<string, string> = {
  per_stay:         'Por estancia',
  per_night:        'Por noche',
  per_person:       'Por persona',
  per_person_night: 'Por persona/noche',
}

const EMPTY = {
  title: '', description: '', icon: '',
  defaultPrice: '', pricingType: 'per_stay', maxQuantity: 1,
  taxRate: '', active: true, activeForBookingEngine: false,
}

type Item = typeof EMPTY & { id?: number; active: boolean; activeForBookingEngine: boolean }

// ─── Pestaña Ventas ───────────────────────────────────────────────────────────

const PAGE_SIZE = 50

function SalesTab() {
  const today         = new Date().toISOString().slice(0, 10)
  const firstOfMonth  = today.slice(0, 7) + '-01'

  const [rows,       setRows]       = useState<any[]>([])
  const [meta,       setMeta]       = useState<{ total: number; totalAmount: string } | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [dateFrom,   setDateFrom]   = useState(firstOfMonth)
  const [dateTo,     setDateTo]     = useState(today)
  const [saleItemId, setSaleItemId] = useState('')
  const [allItems,   setAllItems]   = useState<any[]>([])
  const [page,       setPage]       = useState(1)
  const debounce     = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.listSaleItems().then((r: any) => setAllItems(r.data ?? [])).catch(() => {})
  }, [])

  const load = useCallback(async (p = 1) => {
    setLoading(true)
    try {
      const params: Record<string, string> = { page: String(p), limit: String(PAGE_SIZE) }
      if (dateFrom)   params.dateFrom   = dateFrom
      if (dateTo)     params.dateTo     = dateTo
      if (saleItemId) params.saleItemId = saleItemId
      const r = await api.listExtraSales(params)
      setRows(r.data); setMeta(r.meta); setPage(p)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, saleItemId])

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => load(1), 300)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [load])

  const totalPages = meta ? Math.ceil(meta.total / PAGE_SIZE) : 1

  return (
    <>
      <div className="card" style={{ marginBottom: 14, padding: '12px 16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
            <label>Desde</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
            <label>Hasta</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>Extra</label>
            <select value={saleItemId} onChange={e => setSaleItemId(e.target.value)}>
              <option value="">Todos</option>
              {allItems.map((it: any) => (
                <option key={it.id} value={String(it.id)}>{it.icon ? `${it.icon} ` : ''}{it.title}</option>
              ))}
            </select>
          </div>
          {saleItemId && (
            <button className="btn btn-ghost" style={{ alignSelf: 'flex-end' }}
              onClick={() => setSaleItemId('')}>× Limpiar</button>
          )}
        </div>
      </div>

      {meta && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
          <div className="billing-card" style={{ flex: 1 }}>
            <div className="billing-card-label">Ventas</div>
            <div className="billing-card-value">{meta.total.toLocaleString('es-ES')}</div>
          </div>
          <div className="billing-card" style={{ flex: 1 }}>
            <div className="billing-card-label">Total</div>
            <div className="billing-card-value" style={{ color: 'var(--green)' }}>{fmtMoney(meta.totalAmount)}</div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {loading && <div className="loading" style={{ padding: 20 }}>Cargando…</div>}
        {!loading && (
          <table className="data-table" style={{ minWidth: 680 }}>
            <thead>
              <tr>
                <th style={{ whiteSpace: 'nowrap' }}>Fecha</th>
                <th>Res.</th>
                <th>Hab.</th>
                <th>Estado</th>
                <th>Extra</th>
                <th style={{ textAlign: 'center' }}>Cant.</th>
                <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>P. unit.</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ whiteSpace: 'nowrap' }}>Por</th>
                <th>Notas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => {
                const statusColor = STATUS_COLOR[r.reservationStatus] ?? '#9ca3af'
                return (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text2)' }}>{fmtDateTime(r.createdAt)}</td>
                    <td>
                      <Link to={`/reservations/${r.reservationId}`}
                        style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)' }}>
                        #{r.reservationId}
                      </Link>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{r.roomCode ?? '—'}</td>
                    <td>
                      <span style={{
                        display: 'inline-block', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                        padding: '2px 7px', borderRadius: 6,
                        background: statusColor + '22', color: statusColor, border: `1px solid ${statusColor}55`,
                      }}>
                        {STATUS_LABEL[r.reservationStatus] ?? r.reservationStatus}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
                      {r.saleItemIcon && <span style={{ marginRight: 4 }}>{r.saleItemIcon}</span>}
                      {r.saleItemTitle}
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>{r.quantity}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 13 }}>{fmtMoney(r.unitPrice)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                      {fmtMoney(parseFloat(r.unitPrice) * r.quantity)}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                      {r.createdByFirst ? `${r.createdByFirst} ${r.createdByLast}` : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 140 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                        {r.notes ?? ''}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: 'center', padding: 28, color: 'var(--text2)' }}>
                  Sin ventas para los filtros seleccionados
                </td></tr>
              )}
            </tbody>
          </table>
        )}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '12px 0 4px' }}>
            <button className="btn btn-ghost btn-xs" disabled={page <= 1} onClick={() => load(page - 1)}>‹ Anterior</button>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Página {page} de {totalPages}</span>
            <button className="btn btn-ghost btn-xs" disabled={page >= totalPages} onClick={() => load(page + 1)}>Siguiente ›</button>
          </div>
        )}
      </div>
    </>
  )
}

// ─── Pestaña Configuración ────────────────────────────────────────────────────

function ConfigTab() {
  const [items,   setItems]   = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Item | null>(null)
  const [saving,  setSaving]  = useState(false)
  const [showNew, setShowNew] = useState(false)

  const load = () => {
    setLoading(true)
    api.listSaleItems()
      .then(d => setItems(d.data))
      .catch(e => toast(e.message, 'err'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const startNew = () => { setEditing({ ...EMPTY }); setShowNew(true) }

  const startEdit = (item: any) => {
    setEditing({
      id:                     item.id,
      title:                  item.title,
      description:            item.description ?? '',
      icon:                   item.icon ?? '',
      defaultPrice:           item.defaultPrice ?? '',
      pricingType:            item.pricingType ?? 'per_stay',
      maxQuantity:            item.maxQuantity ?? 1,
      taxRate:                item.taxRate ?? '',
      active:                 item.active,
      activeForBookingEngine: item.activeForBookingEngine,
    })
    setShowNew(false)
  }

  const save = async () => {
    if (!editing) return
    if (!editing.title.trim()) { toast('El nombre es obligatorio', 'err'); return }
    setSaving(true)
    try {
      const payload = {
        title:                  editing.title.trim(),
        description:            editing.description || null,
        icon:                   editing.icon || null,
        defaultPrice:           editing.defaultPrice !== '' ? Number(editing.defaultPrice) : null,
        pricingType:            editing.pricingType,
        maxQuantity:            Number(editing.maxQuantity),
        taxRate:                editing.taxRate !== '' ? Number(editing.taxRate) : null,
        active:                 editing.active,
        activeForBookingEngine: editing.activeForBookingEngine,
      }
      if (editing.id) {
        await api.updateSaleItem(editing.id, payload)
        toast('Extra actualizado')
      } else {
        await api.createSaleItem(payload)
        toast('Extra creado')
      }
      setEditing(null); setShowNew(false)
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const del = async (id: number) => {
    if (!confirm('¿Eliminar este extra permanentemente? Esta acción no se puede deshacer.')) return
    try {
      await api.deleteSaleItem(id)
      toast('Extra eliminado')
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const toggleBooking = async (item: any) => {
    try {
      await api.updateSaleItem(item.id, { activeForBookingEngine: !item.activeForBookingEngine })
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const toggleActive = async (item: any) => {
    try {
      await api.updateSaleItem(item.id, { active: !item.active })
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const set = (k: keyof Item, v: any) => setEditing(p => p ? { ...p, [k]: v } : p)

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-primary" onClick={startNew}>+ Nuevo extra</button>
      </div>

      {(showNew || (editing && !editing.id)) && (
        <ItemForm editing={editing!} set={set} saving={saving} onSave={save} onCancel={() => { setEditing(null); setShowNew(false) }} isNew />
      )}

      {loading ? (
        <div className="loading" style={{ minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="spin" /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Nombre</th>
                <th>Precio</th>
                <th>Tipo</th>
                <th>Cant. máx.</th>
                <th style={{ width: 110 }}>Booking engine</th>
                <th style={{ width: 80 }}>Activo</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text2)', padding: 32 }}>Sin extras. Crea el primero.</td></tr>
              )}
              {items.map(item => (
                <>
                  <tr key={item.id} style={{ opacity: item.active ? 1 : 0.45 }}>
                    <td style={{ fontSize: 20, textAlign: 'center' }}>{item.icon || '—'}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{item.title}</div>
                      {item.description && <div style={{ fontSize: 12, color: 'var(--text2)' }}>{item.description}</div>}
                    </td>
                    <td>{item.defaultPrice ? `${parseFloat(item.defaultPrice).toFixed(2)} €` : '—'}</td>
                    <td style={{ fontSize: 13 }}>{PRICING_LABELS[item.pricingType] ?? item.pricingType}</td>
                    <td style={{ textAlign: 'center' }}>{item.maxQuantity}</td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        onClick={() => toggleBooking(item)}
                        className={`btn btn-sm ${item.activeForBookingEngine ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ fontSize: 12, padding: '3px 10px' }}
                      >
                        {item.activeForBookingEngine ? '✓ Activo' : 'Desact.'}
                      </button>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={item.active} onChange={() => toggleActive(item)} title={item.active ? 'Desactivar' : 'Activar'} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                    </td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => startEdit(item)}>Editar</button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => del(item.id)}>Eliminar</button>
                    </td>
                  </tr>
                  {editing?.id === item.id && editing && (
                    <tr key={`edit-${item.id}`}>
                      <td colSpan={8} style={{ padding: 0 }}>
                        <ItemForm editing={editing} set={set} saving={saving} onSave={save} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ─── Vista principal ──────────────────────────────────────────────────────────

export default function ExtrasView() {
  const { user } = useAuth()
  const isAdmin  = canManage(user)
  const canSee   = canManageReservations(user)

  const [tab, setTab] = useState<'ventas' | 'config'>('ventas')

  // Al entrar en esta vista se da por atendida la alerta de "extras nuevos sin revisar"
  useEffect(() => {
    api.markAlertSeen('new-extras-web-directa').catch(() => {})
  }, [])

  const TABS = [
    { key: 'ventas',  label: 'Ventas',          visible: canSee   },
    { key: 'config',  label: 'Configuración',   visible: isAdmin  },
  ] as const

  const visibleTabs = TABS.filter(t => t.visible)

  return (
    <div className="view-container">
      <div className="view-header">
        <h1 className="view-title">Extras</h1>
        {visibleTabs.length > 1 && (
          <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--border)', alignSelf: 'flex-end' }}>
            {visibleTabs.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '6px 14px', fontWeight: tab === t.key ? 700 : 400,
                color: tab === t.key ? 'var(--accent)' : 'var(--text2)',
                borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -2, fontSize: 14,
              }}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'ventas' && canSee   && <SalesTab />}
      {tab === 'config' && isAdmin  && <ConfigTab />}
    </div>
  )
}

function ItemForm({ editing, set, saving, onSave, onCancel, isNew }: {
  editing: Item; set: (k: keyof Item, v: any) => void
  saving: boolean; onSave: () => void; onCancel: () => void; isNew?: boolean
}) {
  return (
    <div className="card" style={{ marginBottom: 20, border: '2px solid var(--blue)' }}>
      <div className="detail-section-title">{isNew ? 'Nuevo extra' : `Editando: ${editing.title || '…'}`}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 12 }}>
        <div className="form-group">
          <label>Nombre *</label>
          <input value={editing.title} onChange={e => set('title', e.target.value)} placeholder="Desayuno, parking…" />
        </div>
        <div className="form-group">
          <label>Icono (emoji)</label>
          <input value={editing.icon} onChange={e => set('icon', e.target.value)} placeholder="🍳" maxLength={4} style={{ fontSize: 20 }} />
        </div>
        <div className="form-group">
          <label>Precio base (€)</label>
          <input type="number" min={0} step={0.01} value={editing.defaultPrice} onChange={e => set('defaultPrice', e.target.value)} placeholder="0.00" />
        </div>
        <div className="form-group">
          <label>Tipo de precio</label>
          <select value={editing.pricingType} onChange={e => set('pricingType', e.target.value)}>
            {Object.entries(PRICING_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Cantidad máxima</label>
          <input type="number" min={1} max={99} value={editing.maxQuantity} onChange={e => set('maxQuantity', Number(e.target.value))} />
        </div>
        <div className="form-group">
          <label>IVA (%)</label>
          <input type="number" min={0} max={100} step={0.01} value={editing.taxRate} onChange={e => set('taxRate', e.target.value)} placeholder="10" />
        </div>
      </div>
      <div className="form-group" style={{ marginTop: 4 }}>
        <label>Descripción</label>
        <input value={editing.description} onChange={e => set('description', e.target.value)} placeholder="Descripción breve visible en el booking engine" />
      </div>
      <div style={{ display: 'flex', gap: 20, marginTop: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
          <input type="checkbox" checked={editing.active} onChange={e => set('active', e.target.checked)} />
          Activo
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
          <input type="checkbox" checked={editing.activeForBookingEngine} onChange={e => set('activeForBookingEngine', e.target.checked)} />
          Visible en booking engine
        </label>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancelar</button>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  )
}
