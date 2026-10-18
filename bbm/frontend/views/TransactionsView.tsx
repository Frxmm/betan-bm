import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth, canManage } from '../contexts/AuthContext'
import { fmtDateTime, fmtMoney, toast, accountsForMethod } from '../lib/utils'
import { Modal } from '../components/Modal'
import { EditTransactionModal } from '../components/EditTransactionModal'

function MethodBadge({ method, methods }: { method: string; methods: any[] }) {
  const cfg = methods.find(m => m.key === method)
  const color = cfg?.color ?? '#64748b'
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600,
      background: color + '22', color, border: `1px solid ${color}55`,
      borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap',
    }}>
      {cfg?.label ?? method}
    </span>
  )
}


// ─── Modal caja ──────────────────────────────────────────────────────────────

function AccountModal({ account, onClose, onSaved }: {
  account: any | null; onClose: () => void; onSaved: () => void
}) {
  const isNew = !account
  const [name,           setName]           = useState(account?.name ?? '')
  const [isCreditCard,   setIsCreditCard]   = useState(account?.isCreditCard ?? false)
  const [isBankAccount,  setIsBankAccount]  = useState(account?.isBankAccount ?? false)
  const [countInShift,   setCountInShift]   = useState(account?.countInShift ?? true)
  const [isDefault,      setIsDefault]      = useState(account?.isDefault ?? false)
  const [active,         setActive]         = useState(account?.active ?? true)
  const [allowedMethods, setAllowedMethods] = useState<string[]>(account?.allowedMethods ?? [])
  const [allMethods,     setAllMethods]     = useState<any[]>([])
  const [saving,         setSaving]         = useState(false)

  useEffect(() => {
    api.listPaymentMethods().then((r: any) => {
      setAllMethods((r.data ?? []).filter((m: any) => m.active).sort((a: any, b: any) => a.sortOrder - b.sortOrder))
    }).catch(() => {})
  }, [])

  const toggleMethod = (key: string) =>
    setAllowedMethods(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])

  const save = async () => {
    if (!name.trim()) { toast('El nombre es obligatorio', 'err'); return }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(), isCreditCard, isBankAccount, countInShift, isDefault, active,
        allowedMethods: allowedMethods.length > 0 ? allowedMethods : null,
      }
      if (isNew) { await api.createAccount(payload); toast('Caja creada') }
      else       { await api.updateAccount(account.id, payload); toast('Caja actualizada') }
      onSaved()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isNew ? 'Nueva caja' : `Editar: ${account.name}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{isNew ? 'Crear' : 'Guardar'}</button></>
    }>
      <div className="form-grid">
        <div className="form-group full">
          <label>Nombre *</label>
          <input value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        {(['isCreditCard', 'isBankAccount', 'countInShift', 'isDefault'] as const).map(field => (
          <div key={field} className="form-group">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={{ isCreditCard, isBankAccount, countInShift, isDefault }[field]}
                onChange={e => ({ isCreditCard: setIsCreditCard, isBankAccount: setIsBankAccount, countInShift: setCountInShift, isDefault: setIsDefault }[field])(e.target.checked)} />
              {{ isCreditCard: 'Es tarjeta / TPV', isBankAccount: 'Es cuenta bancaria', countInShift: 'Contar en turno', isDefault: 'Caja por defecto' }[field]}
            </label>
          </div>
        ))}
        {!isNew && (
          <div className="form-group">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
              Activa
            </label>
          </div>
        )}
        {allMethods.length > 0 && (
          <div className="form-group full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <label style={{ marginBottom: 8, display: 'block' }}>
              Formas de pago que pueden usar esta caja
              <span style={{ fontWeight: 400, color: 'var(--text2)', fontSize: 12, marginLeft: 6 }}>
                {allowedMethods.length === 0 ? '(sin restricción — visible para todas)' : ''}
              </span>
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {allMethods.map((m: any) => {
                const checked = allowedMethods.includes(m.key)
                return (
                  <label key={m.key} style={{
                    display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    padding: '4px 10px', borderRadius: 6, fontSize: 13,
                    background: checked ? 'rgba(var(--accent-rgb),.12)' : 'var(--bg2)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    userSelect: 'none',
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleMethod(m.key)}
                      style={{ width: 13, height: 13 }} />
                    {m.label}
                  </label>
                )
              })}
            </div>
            {allowedMethods.length > 0 && (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }}
                onClick={() => setAllowedMethods([])}>
                Quitar restricciones (mostrar para todas)
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Modal forma de pago ──────────────────────────────────────────────────────

function PaymentMethodModal({ pm, onClose, onSaved }: {
  pm: any | null; onClose: () => void; onSaved: () => void
}) {
  const isNew = !pm
  const [key,   setKey]   = useState(pm?.key   ?? '')
  const [label, setLabel] = useState(pm?.label ?? '')
  const [color, setColor] = useState(pm?.color ?? '#64748b')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!label.trim()) { toast('La etiqueta es obligatoria', 'err'); return }
    if (isNew && !key.trim()) { toast('La clave es obligatoria', 'err'); return }
    if (isNew && !/^[a-z0-9_]+$/.test(key)) { toast('La clave solo puede contener letras minúsculas, números y _', 'err'); return }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) { toast('Color inválido (formato #rrggbb)', 'err'); return }
    setSaving(true)
    try {
      if (isNew) { await api.createPaymentMethod({ key, label: label.trim(), color }); toast('Forma de pago creada') }
      else       { await api.updatePaymentMethod(pm.id, { label: label.trim(), color }); toast('Forma de pago actualizada') }
      onSaved()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isNew ? 'Nueva forma de pago' : `Editar: ${pm.label}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{isNew ? 'Crear' : 'Guardar'}</button></>
    }>
      <div className="form-grid">
        {isNew && (
          <div className="form-group full">
            <label>Clave interna *</label>
            <input value={key} onChange={e => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="ej: bizum" autoFocus />
            <span className="form-hint">Solo letras minúsculas, números y _. No se puede cambiar después.</span>
          </div>
        )}
        <div className="form-group full">
          <label>Etiqueta *</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="ej: Bizum" autoFocus={!isNew} />
        </div>
        <div className="form-group">
          <label>Color</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="color" value={color} onChange={e => setColor(e.target.value)}
              style={{ width: 40, height: 32, padding: 2, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6 }} />
            <input value={color} onChange={e => setColor(e.target.value)} style={{ width: 100, fontFamily: 'monospace' }} />
            <span style={{ display: 'inline-block', width: 60, padding: '3px 10px', borderRadius: 6, background: color + '22', color, border: `1px solid ${color}55`, fontSize: 11, fontWeight: 600 }}>
              Vista previa
            </span>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ─── Pestaña Configuración ────────────────────────────────────────────────────

function ConfigTab({ globalMethods, onMethodsChanged }: { globalMethods: any[]; onMethodsChanged: () => void }) {
  const [accounts,      setAccounts]      = useState<any[]>([])
  const [allAccounts,   setAllAccounts]   = useState<any[]>([])
  const [showInactive,  setShowInactive]  = useState(false)
  const [editAccount,   setEditAccount]   = useState<any | null>(null)
  const [newAccount,    setNewAccount]    = useState(false)
  const [editPm,        setEditPm]        = useState<any | null>(null)
  const [newPm,         setNewPm]         = useState(false)
  const [delConfirm,    setDelConfirm]    = useState<{ type: 'account' | 'pm'; item: any } | null>(null)
  const [deleting,      setDeleting]      = useState(false)

  const loadAccounts = useCallback(async () => {
    try {
      const r: any = await api.listAccounts()
      setAllAccounts(r.data ?? [])
      setAccounts((r.data ?? []).filter((a: any) => a.active))
    } catch { toast('Error cargando cajas', 'err') }
  }, [])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  const doDelete = async () => {
    if (!delConfirm) return
    setDeleting(true)
    try {
      if (delConfirm.type === 'account') {
        await api.deleteAccount(delConfirm.item.id)
        toast('Caja desactivada')
        loadAccounts()
      } else {
        await api.deletePaymentMethod(delConfirm.item.id)
        toast('Forma de pago eliminada')
        onMethodsChanged()
      }
      setDelConfirm(null)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setDeleting(false) }
  }

  const visibleAccounts = showInactive ? allAccounts : allAccounts.filter((a: any) => a.active)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Cajas ── */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Cajas</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--text2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
              Mostrar inactivas
            </label>
            <button className="btn btn-primary btn-sm" onClick={() => setNewAccount(true)}>+ Nueva caja</button>
          </div>
        </div>
        <table>
          <thead><tr>
            <th>Nombre</th><th>Tipo</th><th>Turno</th><th>Por defecto</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody>
            {visibleAccounts.map((a: any) => (
              <tr key={a.id} style={{ opacity: a.active ? 1 : 0.5 }}>
                <td><strong>{a.name}</strong></td>
                <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                  {a.isCreditCard ? 'TPV / Tarjeta' : a.isBankAccount ? 'Banco' : 'Efectivo / Otro'}
                </td>
                <td style={{ fontSize: 12 }}>{a.countInShift ? '✓' : '—'}</td>
                <td style={{ fontSize: 12 }}>{a.isDefault ? '★' : '—'}</td>
                <td>
                  <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 5, padding: '2px 7px',
                    background: a.active ? '#15803d22' : '#64748b22', color: a.active ? '#15803d' : '#64748b' }}>
                    {a.active ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditAccount(a)}>Editar</button>
                  {a.active && (
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                      onClick={() => setDelConfirm({ type: 'account', item: a })}>Eliminar</button>
                  )}
                </td>
              </tr>
            ))}
            {visibleAccounts.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 20, color: 'var(--text2)' }}>Sin cajas</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Formas de pago ── */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Formas de pago</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setNewPm(true)}>+ Nueva forma de pago</button>
        </div>
        <table>
          <thead><tr>
            <th>Clave</th><th>Etiqueta</th><th>Color</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody>
            {globalMethods.map((m: any) => (
              <tr key={m.id} style={{ opacity: m.active ? 1 : 0.5 }}>
                <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text2)' }}>{m.key}</td>
                <td>
                  <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 600,
                    background: m.color + '22', color: m.color, border: `1px solid ${m.color}55`,
                    borderRadius: 6, padding: '2px 8px' }}>
                    {m.label}
                  </span>
                </td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: m.color, display: 'inline-block' }} />
                    {m.color}
                  </span>
                </td>
                <td>
                  <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 5, padding: '2px 7px',
                    background: m.active ? '#15803d22' : '#64748b22', color: m.active ? '#15803d' : '#64748b' }}>
                    {m.active ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditPm(m)}>Editar</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
                    onClick={() => setDelConfirm({ type: 'pm', item: m })}>Eliminar</button>
                </td>
              </tr>
            ))}
            {globalMethods.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 20, color: 'var(--text2)' }}>Sin formas de pago</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modales */}
      {(newAccount || editAccount) && (
        <AccountModal account={editAccount}
          onClose={() => { setNewAccount(false); setEditAccount(null) }}
          onSaved={() => { setNewAccount(false); setEditAccount(null); loadAccounts() }} />
      )}
      {(newPm || editPm) && (
        <PaymentMethodModal pm={editPm}
          onClose={() => { setNewPm(false); setEditPm(null) }}
          onSaved={() => { setNewPm(false); setEditPm(null); onMethodsChanged() }} />
      )}
      {delConfirm && (
        <Modal title="Confirmar eliminación" onClose={() => setDelConfirm(null)} footer={
          <><button className="btn btn-ghost" onClick={() => setDelConfirm(null)}>Cancelar</button>
            <button className="btn btn-danger" onClick={doDelete} disabled={deleting}>
              {delConfirm.type === 'account' ? 'Desactivar caja' : 'Eliminar'}
            </button></>
        }>
          <p>
            {delConfirm.type === 'account'
              ? <>¿Desactivar la caja <strong>{delConfirm.item.name}</strong>? Las transacciones existentes no se modificarán.</>
              : <>¿Eliminar la forma de pago <strong>{delConfirm.item.label}</strong> (<code>{delConfirm.item.key}</code>)? Las transacciones que la usen seguirán mostrando la clave pero sin etiqueta.</>}
          </p>
        </Modal>
      )}
    </div>
  )
}

// ─── Modal recogida de efectivo ───────────────────────────────────────────────

// Convierte Date/ISO string a "YYYY-MM-DDTHH:MM" para datetime-local input
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function CashCollectionModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const nowInput = () => toLocalInput(new Date().toISOString())

  const [initLoading, setInitLoading] = useState(true)
  const [calcLoading, setCalcLoading] = useState(false)
  const [pending,     setPending]     = useState('0')
  const [history,     setHistory]     = useState<any[]>([])
  const [dateFrom,    setDateFrom]    = useState('')
  const [dateTo,      setDateTo]      = useState(nowInput)
  const [collectedAt, setCollectedAt] = useState(nowInput)
  const [note,        setNote]        = useState('')
  const [saving,      setSaving]      = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Carga inicial: trae historial + defaults del servidor
  useEffect(() => {
    api.listCashCollections().then((r: any) => {
      setHistory(r.data ?? [])
      setPending(r.pending ?? '0')
      setDateFrom(r.dateFrom ? toLocalInput(r.dateFrom) : '')
      setDateTo(r.dateTo ? toLocalInput(r.dateTo) : nowInput())
    }).catch(() => toast('Error cargando recogidas', 'err'))
    .finally(() => setInitLoading(false))
  }, [])

  // Recalcula el total cuando cambia el rango (debounce 400ms)
  useEffect(() => {
    if (initLoading) return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      setCalcLoading(true)
      try {
        const params: Record<string, string> = {}
        if (dateFrom) params.dateFrom = new Date(dateFrom).toISOString()
        if (dateTo)   params.dateTo   = new Date(dateTo).toISOString()
        const r = await api.listCashCollections(params)
        setPending(r.pending ?? '0')
      } catch { /* silencioso */ }
      finally { setCalcLoading(false) }
    }, 400)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [dateFrom, dateTo, initLoading])

  const save = async () => {
    setSaving(true)
    try {
      await api.createCashCollection({
        collectedAt: new Date(collectedAt).toISOString(),
        dateFrom:    dateFrom ? new Date(dateFrom).toISOString() : null,
        dateTo:      dateTo   ? new Date(dateTo).toISOString()   : null,
        note:        note.trim() || undefined,
      })
      toast('Recogida registrada')
      onSaved()
    } catch (e: any) { toast(e.message ?? 'Error al registrar recogida', 'err') }
    finally { setSaving(false) }
  }

  const pendingNum = parseFloat(pending)
  const isLoading  = initLoading || calcLoading

  return (
    <Modal title="Recoger efectivo" onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || initLoading || pendingNum <= 0}>
          {saving ? 'Registrando…' : `Registrar recogida (${fmtMoney(pending)})`}
        </button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Rango de cobros ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Desde (cobros efectivo)</label>
            <input type="datetime-local" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Hasta (cobros efectivo)</label>
            <input type="datetime-local" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
        </div>

        {/* ── Total calculado ── */}
        <div style={{
          background: pendingNum > 0 ? 'rgba(34,197,94,.08)' : 'var(--bg2)',
          border: `1px solid ${pendingNum > 0 ? 'rgba(34,197,94,.3)' : 'var(--border)'}`,
          borderRadius: 10, padding: '14px 20px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
            {dateFrom ? `${dateFrom.replace('T', ' ')} → ${dateTo.replace('T', ' ')}` : `Hasta ${dateTo.replace('T', ' ')}`}
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, fontFamily: 'monospace',
            color: pendingNum > 0 ? 'var(--green)' : 'var(--text2)',
            opacity: isLoading ? 0.5 : 1, transition: 'opacity .2s' }}>
            {fmtMoney(pending)}
          </div>
          {isLoading && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>Calculando…</div>}
        </div>

        {/* ── Cuándo / nota ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Fecha y hora de recogida</label>
            <input type="datetime-local" value={collectedAt} onChange={e => setCollectedAt(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Nota (opcional)</label>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Ej: Entregado en administración" />
          </div>
        </div>

      </div>
    </Modal>
  )
}

// ─── Pestaña Recogidas de efectivo ────────────────────────────────────────────

function CollectionsTab() {
  const [rows,    setRows]    = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modal,   setModal]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.listCashCollections()
      setRows(r.data ?? [])
    } catch { toast('Error cargando recogidas', 'err') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const totalAmount = rows.reduce((s, h) => s + parseFloat(h.amount ?? '0'), 0)

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flex: '1 1 260px' }}>
          <div className="billing-card">
            <div className="billing-card-label">Recogidas</div>
            <div className="billing-card-value">{rows.length}</div>
          </div>
          <div className="billing-card">
            <div className="billing-card-label">Total recogido</div>
            <div className="billing-card-value" style={{ color: 'var(--green)' }}>{fmtMoney(totalAmount)}</div>
          </div>
        </div>
        <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={() => setModal(true)}>
          💰 Registrar recogida
        </button>
      </div>

      {/* overflowX:auto (no hidden): en móvil la tabla se desplaza en horizontal en vez de salir cortada */}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {loading ? (
          <div className="loading" style={{ padding: 24 }}>Cargando…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text2)' }}>
            Sin recogidas registradas todavía.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Recogida el</th>
                <th>Desde (cobros)</th>
                <th>Hasta (cobros)</th>
                <th>Recogido por</th>
                <th>Nota</th>
                <th style={{ textAlign: 'right' }}>Importe</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h: any) => (
                <tr key={h.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtDateTime(h.collectedAt)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                    {h.dateFrom ? fmtDateTime(h.dateFrom) : '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                    {h.dateTo ? fmtDateTime(h.dateTo) : '—'}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {h.collectedByFirstName} {h.collectedByLastName}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 200 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h.note ?? '—'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, fontSize: 13 }}>
                    {fmtMoney(h.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal && (
        <CashCollectionModal
          onClose={() => setModal(false)}
          onSaved={() => { setModal(false); load() }}
        />
      )}
    </>
  )
}

// ─── Vista principal ──────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function TransactionsView() {
  const { user } = useAuth()
  const admin = canManage(user)
  const today = new Date().toISOString().slice(0, 10)
  const firstOfMonth = today.slice(0, 7) + '-01'

  const [tab,           setTab]          = useState<'transactions' | 'collections' | 'config'>('transactions')
  const [dateFrom,      setDateFrom]      = useState(admin ? firstOfMonth : today)
  const [dateTo,        setDateTo]        = useState(today)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [invoiced,      setInvoiced]      = useState('')
  const [channelId,     setChannelId]     = useState('')
  const [page,          setPage]          = useState(1)

  const [rows,     setRows]     = useState<any[]>([])
  const [meta,     setMeta]     = useState<{ total: number; totalAmount: string } | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [channels, setChannels] = useState<any[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [methods,  setMethods]  = useState<any[]>([])
  const [editTx,   setEditTx]   = useState<any | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadMethods = useCallback(async () => {
    try {
      const r: any = await api.listPaymentMethods()
      setMethods(r.data ?? [])
    } catch { /* usa lista vacía */ }
  }, [])

  useEffect(() => {
    fetch('/api/catalog/channels', { credentials: 'include' })
      .then(r => r.json()).then(r => setChannels(r.data ?? [])).catch(() => {})
    loadMethods()
    if (admin) {
      api.listAccounts().then((r: any) => setAccounts(r.data ?? [])).catch(() => {})
    }
  }, [admin, loadMethods])

  const load = useCallback(async (p = 1) => {
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { page: String(p), limit: String(PAGE_SIZE) }
      if (dateFrom)      params.dateFrom      = dateFrom
      if (dateTo)        params.dateTo        = dateTo
      if (paymentMethod) params.paymentMethod = paymentMethod
      if (invoiced)      params.invoiced      = invoiced
      if (channelId)     params.channelId     = channelId
      const res = await api.listTransactions(params)
      setRows(res.data); setMeta(res.meta); setPage(p)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo, paymentMethod, invoiced, channelId])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load(1), 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [load])

  const totalPages = meta ? Math.ceil(meta.total / PAGE_SIZE) : 1
  const fmt = (v: string | number) =>
    parseFloat(String(v)).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Transacciones</h2>
          <p className="view-subtitle">Cobros imputados en el sistema</p>
        </div>
        {admin && (
          <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--border)', alignSelf: 'flex-end' }}>
            {([
              ['transactions', 'Transacciones'],
              ['collections',  'Recogidas'],
              ['config',       'Configuración'],
            ] as const).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '6px 14px', fontWeight: tab === key ? 700 : 400,
                color: tab === key ? 'var(--accent)' : 'var(--text2)',
                borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -2, fontSize: 14,
              }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'config'      && admin && <ConfigTab globalMethods={methods} onMethodsChanged={loadMethods} />}
      {tab === 'collections' && admin && <CollectionsTab />}
      {tab === 'transactions' && (
        <>
          <div className="card" style={{ marginBottom: 14, padding: '12px 16px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
              <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
                <label>{admin ? 'Desde' : 'Día'}</label>
                <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); if (!admin) setDateTo(e.target.value) }} />
              </div>
              {admin && (
                <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
                  <label>Hasta</label>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                </div>
              )}
              <div className="form-group" style={{ marginBottom: 0, minWidth: 160 }}>
                <label>Forma de pago</label>
                <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                  <option value="">Todas</option>
                  {methods.filter(m => m.active).map((m: any) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, minWidth: 140 }}>
                <label>Facturada</label>
                <select value={invoiced} onChange={e => setInvoiced(e.target.value)}>
                  <option value="">Todas</option>
                  <option value="yes">Sí, facturada</option>
                  <option value="no">No facturada</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, minWidth: 160 }}>
                <label>Canal</label>
                <select value={channelId} onChange={e => setChannelId(e.target.value)}>
                  <option value="">Todos</option>
                  {channels.map((ch: any) => <option key={ch.id} value={String(ch.id)}>{ch.name}</option>)}
                </select>
              </div>
              {(paymentMethod || invoiced || channelId) && (
                <button className="btn btn-ghost" style={{ alignSelf: 'flex-end' }}
                  onClick={() => { setPaymentMethod(''); setInvoiced(''); setChannelId('') }}>× Limpiar</button>
              )}
            </div>
          </div>

          {meta && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div className="billing-card" style={{ flex: 1 }}>
                <div className="billing-card-label">Transacciones</div>
                <div className="billing-card-value">{meta.total.toLocaleString('es-ES')}</div>
              </div>
              <div className="billing-card" style={{ flex: 1 }}>
                <div className="billing-card-label">Total imputado</div>
                <div className="billing-card-value" style={{ color: 'var(--green)' }}>{fmt(meta.totalAmount)}</div>
              </div>
            </div>
          )}

          <div className="card">
            {loading && <div className="loading" style={{ padding: 20 }}>Cargando…</div>}
            {error   && <div className="empty" style={{ padding: 20, color: 'var(--red)' }}>{error}</div>}
            {!loading && !error && (
              <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Fecha</th><th>Reserva</th><th>Huésped</th><th>Habitación</th>
                  <th>OTA</th><th>Forma de pago</th><th>Caja</th><th>Nº de pedido</th>
                  <th style={{ textAlign: 'right' }}>Importe</th>
                  <th>Facturada</th><th>Usuario</th><th>Cobrado en otro turno</th><th>Descripción</th>
                  {admin && <th></th>}
                </tr></thead>
                <tbody>
                  {rows.map((tx: any) => {
                    const res      = tx.reservation
                    const guest    = res?.guest
                    const room     = res?.room
                    const isInv    = res?.invoices?.length > 0
                    return (
                      <tr key={tx.id}>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text2)' }}>{fmtDateTime(tx.createdAt)}</td>
                        <td>
                          {res
                            ? <Link to={`/reservations/${res.id}`} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                #{res.id}{res.externalCode ? ` · ${res.externalCode}` : ''}
                              </Link>
                            : <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ fontSize: 13 }}>
                          {guest ? `${guest.firstName} ${guest.lastName}` : <span style={{ color: 'var(--text2)' }}>—</span>}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{room?.code ?? '—'}</td>
                        <td style={{ fontSize: 12 }}>
                          {res?.bookingChannel?.name
                            ? <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{res.bookingChannel.name}</span>
                            : <span style={{ color: 'var(--text2)' }}>Directo</span>}
                        </td>
                        <td><MethodBadge method={tx.paymentMethod} methods={methods} /></td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{tx.financialAccount?.name ?? '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                          {tx.cardOperationNumber ?? '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: 13 }}>{fmt(tx.amount)}</td>
                        <td>
                          {isInv
                            ? <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>● Sí</span>
                            : <span style={{ fontSize: 11, color: 'var(--text2)' }}>○ No</span>}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                          {tx.createdByUser ? `${tx.createdByUser.firstName} ${tx.createdByUser.lastName}` : (tx.user ?? '—')}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                          {tx.paidByUser
                            ? <span title={tx.collectedAt ? fmtDateTime(tx.collectedAt) : undefined}>
                                Sí — {tx.paidByUser.firstName} {tx.paidByUser.lastName}{tx.collectedAt ? ` (${fmtDateTime(tx.collectedAt)})` : ''}
                              </span>
                            : '—'}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 200 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                            {tx.description ?? tx.category ?? ''}
                          </span>
                        </td>
                        {admin && (
                          <td><button className="btn btn-ghost btn-sm" onClick={() => setEditTx(tx)}>Editar</button></td>
                        )}
                      </tr>
                    )
                  })}
                  {rows.length === 0 && (
                    <tr><td colSpan={admin ? 14 : 13} style={{ textAlign: 'center', padding: 24, color: 'var(--text2)' }}>
                      Sin transacciones para los filtros seleccionados
                    </td></tr>
                  )}
                </tbody>
              </table>
              </div>
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
      )}

      {editTx && (
        <EditTransactionModal tx={editTx} accounts={accounts}
          onClose={() => setEditTx(null)}
          onSaved={() => { setEditTx(null); load(page) }} />
      )}
    </>
  )
}
