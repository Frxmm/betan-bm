import { useState, useEffect, useCallback, useRef } from 'react'
import { api, type Rate, type Operator } from '../lib/api'
import { toast, rootRateOf } from '../lib/utils'
import { Modal } from '../components/Modal'
import { useAuth, canManage } from '../contexts/AuthContext'

const OP_COLORS: Record<string, { bg: string; color: string }> = {
  booking:   { bg: '#003580', color: '#fff' },
  airbnb:    { bg: '#ff385c', color: '#fff' },
  expedia:   { bg: '#00355f', color: '#ffcc00' },
  agoda:     { bg: '#e5383b', color: '#fff' },
  hotelbeds: { bg: '#0066cc', color: '#fff' },
  despegar:  { bg: '#00a1e4', color: '#fff' },
  tui:       { bg: '#c8102e', color: '#fff' },
}

function opColor(code?: string) {
  return OP_COLORS[code ?? ''] ?? { bg: 'var(--bg3)', color: 'var(--text2)' }
}

export default function RatesView() {
  const { user }                        = useAuth()
  const isAdmin                         = canManage(user)
  const [tab,       setTab]             = useState<'rates' | 'seasons' | 'rules' | 'config' | 'promos'>('rates')
  const [rates,      setRates]      = useState<Rate[]>([])
  const [operators,  setOperators]  = useState<Operator[]>([])
  const [seasons,    setSeasons]    = useState<any[]>([])
  const [rules,      setRules]      = useState<any[]>([])
  const [roomTypeList, setRoomTypeList] = useState<any[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [editing,    setEditing]    = useState<Rate | null | 'new'>(null)
  const [showOps,    setShowOps]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [r, o, s, ru, rt]: any[] = await Promise.all([
        api.listRates(), api.listOperators(), api.listSeasons(), api.listPricingRules(), api.listRoomTypes(),
      ])
      setRates(r.data.slice().sort((a: Rate, b: Rate) => a.id - b.id))
      setOperators(o.data)
      setSeasons(s.data)
      setRules(ru.data)
      setRoomTypeList(rt.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const ratesById  = Object.fromEntries(rates.map(r => [r.id, r]))
  const opById     = Object.fromEntries(operators.map(o => [o.id, o]))

  const doLock = async (id: number) => {
    if (!confirm('¿Bloquear esta tarifa? Los usuarios no podrán editarla hasta que la desbloquees.')) return
    try { await api.lockRate(id); load() }
    catch (e: any) { toast(e.message, 'err') }
  }
  const doUnlock   = async (id: number) => { try { await api.unlockRate(id); load() } catch (e: any) { toast(e.message, 'err') } }
  const doToggle   = async (id: number, val: boolean) => {
    try { await api.updateRate(id, { userEditable: val }) }
    catch (e: any) { toast(e.message, 'err'); load() }
  }
  const doDelete = async (id: number, title: string) => {
    if (!confirm(`¿Eliminar la tarifa "${title}"? Esta acción no se puede deshacer.`)) return
    try { await api.deleteRate(id); toast('Tarifa eliminada'); load() }
    catch (e: any) { toast(e.message, 'err') }
  }

  if (loading) return <div className="loading">Cargando tarifas…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Tarifas y precios</h2>
          <p className="view-subtitle">{rates.length} tarifas · {seasons.length} temporadas · {rules.length} reglas</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab === 'rates' && <>
            <button className="btn btn-secondary" onClick={() => setShowOps(true)}>Operadores</button>
            <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Nueva tarifa</button>
          </>}
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={`tab-btn${tab === 'rates'   ? ' active' : ''}`} onClick={() => setTab('rates')}>Tarifas</button>
        <button className={`tab-btn${tab === 'seasons' ? ' active' : ''}`} onClick={() => setTab('seasons')}>Temporadas</button>
        <button className={`tab-btn${tab === 'rules'   ? ' active' : ''}`} onClick={() => setTab('rules')}>Reglas dinámicas</button>
        <button className={`tab-btn${tab === 'config'  ? ' active' : ''}`} onClick={() => setTab('config')}>Configuración</button>
        <button className={`tab-btn${tab === 'promos'  ? ' active' : ''}`} onClick={() => setTab('promos')}>Promociones Web</button>
      </div>

      {tab === 'rates' && <>
        <div className="rates-table-header rate-row">
          <div className="rate-col-name">Tarifa</div>
          <div className="rate-col-rule">Regla de creación</div>
          <div className="rate-col-op">Operador</div>
          <div className="rate-col-value">Ajuste / Precio</div>
          <div className="rate-col-controls">Control</div>
        </div>

        <div id="rates-list">
          {rates.map(rate => (
            <RateRow key={rate.id} rate={rate} ratesById={ratesById} opById={opById}
              isAdmin={isAdmin}
              onEdit={() => setEditing(rate)}
              onLock={() => doLock(rate.id)}
              onUnlock={() => doUnlock(rate.id)}
              onToggleEditable={val => doToggle(rate.id, val)}
              onToggleBookingEngine={async val => {
                try { await api.updateRate(rate.id, { activeForBookingEngine: val }); load() }
                catch (e: any) { toast(e.message, 'err') }
              }}
              onDelete={() => doDelete(rate.id, rate.title)}
              onSavePrice={async val => {
                try { await api.updateRate(rate.id, { adjustValue: val }); load() }
                catch (e: any) { toast(e.message, 'err') }
              }}
            />
          ))}
        </div>

        {operators.length > 0 && (
          <div className="rates-operators-panel">
            <h3>Operadores conectados</h3>
            <div className="op-chips">
              {operators.map(o => {
                const c = opColor(o.code)
                return <span key={o.id} className="op-chip" style={{ background: c.bg, color: c.color }}>{o.name}</span>
              })}
            </div>
          </div>
        )}
      </>}

      {tab === 'seasons' && (
        <SeasonsPanel seasons={seasons} rootName={rootRateOf(rates as any[])?.title} onChanged={load} />
      )}

      {tab === 'rules' && (
        <PricingRulesPanel rules={rules} allRates={rates} allRoomTypes={roomTypeList} onChanged={load} />
      )}

      {tab === 'config' && (
        <RoomTypeDerivationPanel roomTypeList={roomTypeList} onChanged={load} />
      )}

      {tab === 'promos' && (
        <>
          <CancellationRecoveryPanel />
          <CartRecoveryPanel />
          <TemporaryDiscountPanel />
        </>
      )}

      {editing !== null && (
        <RateModal
          rate={editing === 'new' ? null : editing}
          allRates={rates}
          operators={operators}
          roomTypeList={roomTypeList}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {showOps && (
        <OperatorsModal
          operators={operators}
          onClose={() => setShowOps(false)}
          onSaved={() => { setShowOps(false); load() }}
        />
      )}
    </>
  )
}

function RateRow({ rate, ratesById, opById, isAdmin, onEdit, onLock, onUnlock, onToggleEditable, onToggleBookingEngine, onDelete, onSavePrice }:
  { rate: Rate; ratesById: Record<number, Rate>; opById: Record<number, Operator>;
    isAdmin: boolean;
    onToggleBookingEngine: (v: boolean) => void;
    onEdit: () => void; onLock: () => void; onUnlock: () => void;
    onToggleEditable: (v: boolean) => void; onDelete: () => void; onSavePrice: (v: number) => void }) {

  const inputRef = useRef<HTMLInputElement>(null)
  const op = rate.operatorId ? opById[rate.operatorId] : (rate.operator ?? null)
  const c  = opColor(op?.code)
  const isDisabled = rate.locked || !rate.userEditable

  const base = rate.baseRateId ? ratesById[rate.baseRateId] : null
  let ruleBadge: string
  if (!rate.baseRateId) {
    ruleBadge = 'Independiente'
  } else {
    const baseName = base ? (base.code ?? base.title) : `#${rate.baseRateId}`
    if (!rate.adjustType || rate.adjustValue == null) {
      ruleBadge = `← ${baseName}`
    } else {
      const adj  = parseFloat(rate.adjustValue ?? '0')
      const sign = adj >= 0 ? '+' : ''
      const fmt  = rate.adjustType === 'percentage'  ? `${sign}${adj}%`
                 : rate.adjustType === 'amount'      ? `${sign}${adj.toFixed(2)} €`
                 : rate.adjustType === 'fixed'       ? `${adj.toFixed(2)} € fijo`
                 : rate.adjustType === 'per_person'  ? `${sign}${adj.toFixed(2)} €/pers`
                 : ''
      ruleBadge = `← ${baseName} ${fmt}`
    }
  }

  const handleBlur = () => {
    if (!inputRef.current) return
    const val = parseFloat(inputRef.current.value)
    if (isNaN(val)) { inputRef.current.value = parseFloat(rate.adjustValue ?? '0').toFixed(2); return }
    onSavePrice(val)
  }

  return (
    <div className={`rate-row rate-row-flat${rate.locked ? ' rate-row-locked' : ''}`} data-id={rate.id}>
      <div className="rate-col-name">
        <span className="rate-title">{rate.title}</span>
        {rate.code && <span className="rate-code">{rate.code}</span>}
      </div>
      <div className="rate-col-rule">
        <span className={`rate-rule-badge${!rate.baseRateId ? ' opacity-40' : ''}`}
          style={!rate.baseRateId ? { opacity: 0.4 } : undefined}>{ruleBadge}</span>
      </div>
      <div className="rate-col-op">
        {op && <span className="rate-op-badge" style={{ background: c.bg, color: c.color }} title={op.name}>{op.name}</span>}
      </div>
      <div className="rate-col-value">
        <input ref={inputRef} className="rate-price-input" type="number" step="0.01"
          defaultValue={parseFloat(rate.adjustValue ?? '0').toFixed(2)}
          disabled={isDisabled}
          onBlur={handleBlur}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        />
      </div>
      <div className="rate-col-controls">
        {((rate as any).minStay > 1 || (rate as any).maxStay) && (
          <span className="rate-stay-badge" title={`Estancia: mín. ${(rate as any).minStay} noches${(rate as any).maxStay ? ` · máx. ${(rate as any).maxStay}` : ''}`}>
            {(rate as any).minStay > 1 ? `≥${(rate as any).minStay}n` : ''}{(rate as any).maxStay ? `${(rate as any).minStay > 1 ? '/' : ''}≤${(rate as any).maxStay}n` : ''}
          </span>
        )}
        <label className="rate-toggle" title="Visible en motor de reservas web">
          <input type="checkbox" defaultChecked={rate.activeForBookingEngine}
            onChange={e => onToggleBookingEngine(e.target.checked)} />
          <span>Web</span>
        </label>
        <label className={`rate-toggle${rate.locked ? ' rate-toggle-disabled' : ''}`} title="Editable por usuario">
          <input type="checkbox" defaultChecked={rate.userEditable} disabled={rate.locked}
            onChange={e => onToggleEditable(e.target.checked)} />
          <span>Usuario</span>
        </label>
        {rate.locked
          ? <button className="rate-lock-btn locked" title="Bloqueada — clic para desbloquear" onClick={onUnlock}>🔒</button>
          : <button className="rate-lock-btn unlocked" title="Bloquear tarifa" onClick={onLock}>🔓</button>}
        <button className="btn btn-ghost btn-xs" title="Editar tarifa" onClick={onEdit}>✎</button>
        {isAdmin && (
          <button className="btn btn-ghost btn-xs rate-delete-btn" title="Eliminar tarifa" onClick={onDelete}>✕</button>
        )}
      </div>
    </div>
  )
}

function RateModal({ rate, allRates, operators, roomTypeList, onClose, onSaved }:
  { rate: Rate | null; allRates: Rate[]; operators: Operator[]; roomTypeList: any[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !rate
  const [form, setForm] = useState({
    title:        rate?.title ?? '',
    code:         rate?.code ?? '',
    description:  rate?.description ?? '',
    baseRateId:   rate?.baseRateId ? String(rate.baseRateId) : '',
    adjustType:   rate?.adjustType ?? 'fixed',
    adjustValue:  rate?.adjustValue ?? '0',
    operatorId:   rate?.operatorId ? String(rate.operatorId) : '',
    roomTypeId:   (rate as any)?.roomTypeId ? String((rate as any).roomTypeId) : '',
    minStay:      String((rate as any)?.minStay ?? 1),
    maxStay:      String((rate as any)?.maxStay ?? ''),
    userEditable: rate?.userEditable !== false,
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const chk = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.checked }))

  const save = async () => {
    if (!form.title.trim()) { toast('El nombre es obligatorio', 'err'); return }
    setSaving(true)
    try {
      const minStay = parseInt(form.minStay) || 1
      const maxStay = parseInt(form.maxStay) || null
      if (maxStay !== null && maxStay < minStay) { toast('La estancia máxima debe ser ≥ mínima', 'err'); return }
      const payload = {
        title:        form.title.trim(),
        code:         (form as any).code?.trim() || null,
        description:  form.description.trim() || null,
        baseRateId:   form.baseRateId ? Number(form.baseRateId) : null,
        adjustType:   form.adjustType,
        adjustValue:  parseFloat(form.adjustValue) || 0,
        operatorId:   form.operatorId ? Number(form.operatorId) : null,
        roomTypeId:   form.roomTypeId ? Number(form.roomTypeId) : null,
        minStay,
        maxStay,
        userEditable: form.userEditable,
      }
      if (isNew) await api.createRate({ ...payload, active: true })
      else       await api.updateRate(rate!.id, payload)
      toast(isNew ? 'Tarifa creada' : 'Tarifa actualizada')
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  const baseOptions = allRates.filter(r => !rate || r.id !== rate.id)

  return (
    <Modal title={isNew ? 'Nueva tarifa' : `Editar: ${rate!.title}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
    }>
      <div className="form-grid">
        <div className="form-group"><label>Nombre *</label><input value={form.title} onChange={set('title')} /></div>
        <div className="form-group"><label>Código</label><input value={form.code} onChange={set('code')} placeholder="Ej: WEB_AL" /></div>
        <div className="form-group full"><label>Descripción</label><input value={form.description} onChange={set('description')} /></div>
      </div>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Regla de creación</legend>
        <div className="form-grid">
          <div className="form-group">
            <label>Tarifa base</label>
            <select value={form.baseRateId} onChange={set('baseRateId')}>
              <option value="">— Es tarifa base —</option>
              {baseOptions.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ opacity: form.baseRateId ? 1 : 0.4 }}>
            <label>Ajuste</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={form.adjustType} onChange={set('adjustType')} style={{ width: 150 }}>
                <option value="fixed">Fijo (€)</option>
                <option value="percentage">Porcentaje (%)</option>
                <option value="amount">Importe (+€)</option>
                <option value="per_person">Por persona (+€/pers)</option>
              </select>
              <input type="number" step="0.01" value={form.adjustValue} onChange={set('adjustValue')} style={{ flex: 1 }} />
            </div>
          </div>
        </div>
      </fieldset>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Tipo de habitación y operador</legend>
        <div className="form-grid">
          <div className="form-group">
            <label>Tipo de habitación</label>
            <select value={form.roomTypeId} onChange={set('roomTypeId')}>
              <option value="">— Sin tipo —</option>
              {roomTypeList.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Operador (OTA)</label>
            <select value={form.operatorId} onChange={set('operatorId')}>
              <option value="">— Sin operador —</option>
              {operators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
            <input type="checkbox" id="re-ue" checked={form.userEditable} onChange={chk('userEditable')} />
            <label htmlFor="re-ue">Editable por usuario</label>
          </div>
        </div>
      </fieldset>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Restricciones de estancia</legend>
        <div className="form-grid">
          <div className="form-group">
            <label>Mínimo de noches</label>
            <input type="number" min={1} step={1} value={form.minStay} onChange={set('minStay')} placeholder="1" />
          </div>
          <div className="form-group">
            <label>Máximo de noches <span style={{ color: 'var(--text2)', fontWeight: 400 }}>(opcional)</span></label>
            <input type="number" min={1} step={1} value={form.maxStay} onChange={set('maxStay')} placeholder="Sin límite" />
          </div>
        </div>
      </fieldset>
    </Modal>
  )
}

// ── Temporadas ────────────────────────────────────────────────────────────────

function SeasonsPanel({ seasons, rootName, onChanged }: { seasons: any[]; rootName?: string; onChanged: () => void }) {
  const empty = { name: '', dateFrom: '', dateTo: '', minPrice: '', color: '#3b82f6' }
  const [form,    setForm]    = useState(empty)
  const [editing, setEditing] = useState<any | null>(null)
  const [saving,  setSaving]  = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const payload = () => ({
    name:     form.name.trim(),
    dateFrom: form.dateFrom,
    dateTo:   form.dateTo,
    minPrice: form.minPrice !== '' ? parseFloat(form.minPrice) : null,
    color:    form.color,
  })

  const save = async () => {
    if (!form.name || !form.dateFrom || !form.dateTo) { toast('Nombre y fechas obligatorios', 'err'); return }
    setSaving(true)
    try {
      if (editing) await api.updateSeason(editing.id, payload())
      else         await api.createSeason(payload())
      toast(editing ? 'Temporada actualizada' : 'Temporada creada')
      setForm(empty); setEditing(null); onChanged()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const del = async (id: number, name: string) => {
    if (!confirm(`¿Eliminar "${name}"?`)) return
    try { await api.deleteSeason(id); onChanged() }
    catch (e: any) { toast(e.message, 'err') }
  }

  const edit = (s: any) => { setEditing(s); setForm({ name: s.name, dateFrom: s.dateFrom, dateTo: s.dateTo, minPrice: s.minPrice ?? '', color: s.color }) }
  const cancel = () => { setEditing(null); setForm(empty) }

  return (
    <div>
      <table className="data-table" style={{ marginBottom: 24 }}>
        <thead><tr>
          <th>Nombre</th><th>Desde</th><th>Hasta</th><th>Precio mín. {rootName ?? 'tarifa raíz'}</th><th>Color</th><th></th>
        </tr></thead>
        <tbody>
          {seasons.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text2)', textAlign: 'center' }}>Sin temporadas</td></tr>}
          {seasons.map(s => (
            <tr key={s.id}>
              <td><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: s.color, marginRight: 6 }} />{s.name}</td>
              <td>{s.dateFrom}</td>
              <td>{s.dateTo}</td>
              <td>{s.minPrice != null ? `${parseFloat(s.minPrice).toFixed(2)} €` : '—'}</td>
              <td><input type="color" value={s.color} readOnly style={{ width: 28, height: 24, border: 'none', cursor: 'default', padding: 0 }} /></td>
              <td style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-ghost btn-xs" onClick={() => edit(s)}>✎</button>
                <button className="btn btn-ghost btn-xs" onClick={() => del(s.id, s.name)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>{editing ? `Editando: ${editing.name}` : 'Nueva temporada'}</legend>
        <div className="form-grid">
          <div className="form-group"><label>Nombre *</label><input value={form.name} onChange={set('name')} placeholder="Temporada Alta" /></div>
          <div className="form-group"><label>Desde *</label><input type="date" value={form.dateFrom} onChange={set('dateFrom')} /></div>
          <div className="form-group"><label>Hasta *</label><input type="date" value={form.dateTo} onChange={set('dateTo')} /></div>
          <div className="form-group"><label>Precio mín. {rootName ?? 'tarifa raíz'}</label><input type="number" min="0" step="0.01" value={form.minPrice} onChange={set('minPrice')} placeholder="Ej: 60" /></div>
          <div className="form-group"><label>Color</label><input type="color" value={form.color} onChange={set('color')} style={{ width: 48, height: 32, padding: 2 }} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Guardar cambios' : '+ Añadir'}</button>
          {editing && <button className="btn btn-ghost" onClick={cancel}>Cancelar</button>}
        </div>
      </fieldset>
    </div>
  )
}

// ── Reglas dinámicas ──────────────────────────────────────────────────────────

const RULE_TYPE_DEFAULTS: Record<string, { thresholdPct: string; adjustValue: string; minAdrFloorPct?: string; pulseSilenceMinutes?: string; clearanceOverrideMinutes?: string; clearanceStartHour?: string }> = {
  low_availability:    { thresholdPct: '15', adjustValue: '10' },
  lead_time_dip:       { thresholdPct: '60', adjustValue: '10' },
  local_min_dip:       { thresholdPct: '40', adjustValue: '10' },
  demand_pulse_dip:    { thresholdPct: '90', adjustValue: '7.5', minAdrFloorPct: '90', pulseSilenceMinutes: '240' },
  competitor_undercut: { thresholdPct: '60', adjustValue: '5' },
  sold_out_upsell:     { thresholdPct: '15', adjustValue: '10' },
  evening_clearance_dip: { thresholdPct: '100', adjustValue: '7', minAdrFloorPct: '100', clearanceOverrideMinutes: '60', clearanceStartHour: '20' },
  booking_surge:        { thresholdPct: '60', adjustValue: '10' },
}
// Prioridad inicial sugerida por tipo (número menor = gana) — la misma que
// tenía el orden fijo del motor; editable por regla.
const RULE_PRIORITY_DEFAULTS: Record<string, string> = {
  demand_pulse_dip: '10', evening_clearance_dip: '20', booking_surge: '25', sold_out_upsell: '30', lead_time_dip: '40',
  local_min_dip: '50', low_availability: '60', competitor_undercut: '70',
}
// thresholdPct no se usa en sold_out_upsell (la condición es "0 disponibles",
// no un umbral de %) — se manda igualmente (valor por defecto) porque el
// backend lo exige como campo, simplemente el motor lo ignora para esta regla.

function PricingRulesPanel({ rules, allRates, allRoomTypes, onChanged }: { rules: any[]; allRates: any[]; allRoomTypes: any[]; onChanged: () => void }) {
  const rootName = rootRateOf(allRates as any[])?.title
  const empty = {
    name: '', ruleType: 'low_availability', thresholdPct: '15', adjustType: 'percentage', adjustValue: '10',
    minAdrFloorPct: '90', pulseSilenceMinutes: '240', clearanceOverrideMinutes: '60', clearanceStartHour: '20',
    referenceRateId: '', sourceRoomTypeId: '', targetRoomTypeId: '', priority: '60', active: true,
  }
  const [form,    setForm]    = useState(empty)
  const [editing, setEditing] = useState<any | null>(null)
  const [saving,  setSaving]  = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const setRuleType = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const ruleType = e.target.value
    setForm(f => ({
      ...f, ruleType, ...RULE_TYPE_DEFAULTS[ruleType], priority: RULE_PRIORITY_DEFAULTS[ruleType] ?? '100',
      // competitor_undercut, sold_out_upsell y evening_clearance_dip siempre
      // interpretan adjustValue como %/€ fijos propios — el selector de tipo
      // de ajuste se oculta.
      ...(ruleType === 'competitor_undercut' ? { adjustType: 'percentage' } : {}),
      ...(ruleType === 'sold_out_upsell' ? { adjustType: 'fixed' } : {}),
      ...(ruleType === 'evening_clearance_dip' ? { adjustType: 'percentage' } : {}),
      ...(ruleType === 'booking_surge' ? { adjustType: 'percentage' } : {}),
    }))
  }

  const payload = () => ({
    name:         form.name.trim(),
    ruleType:     form.ruleType as 'low_availability' | 'lead_time_dip' | 'local_min_dip' | 'demand_pulse_dip' | 'competitor_undercut' | 'sold_out_upsell' | 'evening_clearance_dip' | 'booking_surge',
    thresholdPct: parseInt(form.thresholdPct),
    adjustType:   form.adjustType as 'fixed' | 'percentage',
    adjustValue:  parseFloat(form.adjustValue),
    priority:     parseInt(form.priority) || 100,
    ...(form.ruleType === 'demand_pulse_dip' || form.ruleType === 'evening_clearance_dip' ? { minAdrFloorPct: parseInt(form.minAdrFloorPct) } : {}),
    ...(form.ruleType === 'demand_pulse_dip' ? { pulseSilenceMinutes: parseInt(form.pulseSilenceMinutes) } : {}),
    ...(form.ruleType === 'evening_clearance_dip' ? {
      clearanceOverrideMinutes: parseInt(form.clearanceOverrideMinutes),
      clearanceStartHour: parseInt(form.clearanceStartHour),
    } : {}),
    ...(form.ruleType === 'competitor_undercut' ? { referenceRateId: form.referenceRateId ? parseInt(form.referenceRateId) : null } : {}),
    ...(form.ruleType === 'sold_out_upsell' ? {
      sourceRoomTypeId: form.sourceRoomTypeId ? parseInt(form.sourceRoomTypeId) : null,
      targetRoomTypeId: form.targetRoomTypeId ? parseInt(form.targetRoomTypeId) : null,
    } : {}),
    active:       form.active,
  })

  const save = async () => {
    if (!form.name) { toast('Nombre obligatorio', 'err'); return }
    if (form.ruleType === 'competitor_undercut' && !form.referenceRateId) {
      toast('Elige la tarifa de referencia', 'err'); return
    }
    if (form.ruleType === 'sold_out_upsell' && (!form.sourceRoomTypeId || !form.targetRoomTypeId)) {
      toast('Elige el tipo de habitación que se agota y el que se rebaja', 'err'); return
    }
    setSaving(true)
    try {
      if (editing) await api.updatePricingRule(editing.id, payload())
      else         await api.createPricingRule(payload())
      toast(editing ? 'Regla actualizada' : 'Regla creada')
      setForm(empty); setEditing(null); onChanged()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const del = async (id: number, name: string) => {
    if (!confirm(`¿Eliminar "${name}"?`)) return
    try { await api.deletePricingRule(id); onChanged() }
    catch (e: any) { toast(e.message, 'err') }
  }

  const toggle = async (r: any) => {
    try { await api.updatePricingRule(r.id, { active: !r.active }); onChanged() }
    catch (e: any) { toast(e.message, 'err') }
  }

  const edit = (r: any) => {
    setEditing(r)
    setForm({
      name: r.name, ruleType: r.ruleType ?? 'low_availability', thresholdPct: String(r.thresholdPct),
      adjustType: r.adjustType, adjustValue: String(r.adjustValue),
      minAdrFloorPct: String(r.minAdrFloorPct ?? 90),
      pulseSilenceMinutes: String(r.pulseSilenceMinutes ?? 240),
      clearanceOverrideMinutes: String(r.clearanceOverrideMinutes ?? 60),
      clearanceStartHour: String(r.clearanceStartHour ?? 20),
      referenceRateId: r.referenceRateId != null ? String(r.referenceRateId) : '',
      sourceRoomTypeId: r.sourceRoomTypeId != null ? String(r.sourceRoomTypeId) : '',
      targetRoomTypeId: r.targetRoomTypeId != null ? String(r.targetRoomTypeId) : '',
      priority: String(r.priority ?? 100), active: r.active,
    })
  }
  const cancel = () => { setEditing(null); setForm(empty) }

  const rateName     = (id: number | null) => id != null ? (allRates.find(r => r.id === id)?.title ?? `#${id}`) : '?'
  const roomTypeName = (id: number | null) => id != null ? (allRoomTypes.find(rt => rt.id === id)?.name ?? `#${id}`) : '?'

  const fmtRule = (r: any) => {
    const adj = parseFloat(r.adjustValue)
    const fmtAdj = r.adjustType === 'percentage' ? `${adj}%` : `${adj.toFixed(2)} €`
    if (r.ruleType === 'lead_time_dip') {
      return `Ocupación (día = hoy + lead time medio Booking.com) < ${r.thresholdPct}% → -${fmtAdj}`
    }
    if (r.ruleType === 'local_min_dip') {
      return `Mínimos locales de ocupación (hoy+3 a hoy+60) < ${r.thresholdPct}% → -${fmtAdj}`
    }
    if (r.ruleType === 'demand_pulse_dip') {
      const silenceMin = r.pulseSilenceMinutes ?? 240
      const silenceLabel = silenceMin % 60 === 0 ? `${silenceMin / 60}h` : `${silenceMin} min`
      return `Sin reservas nuevas ${silenceLabel} seguidos cuya estadía pase por esa noche (hoy a hoy+3, ocupación < ${r.thresholdPct}%) → -${fmtAdj} por bloque, sube +${(adj / 2).toFixed(2)}${r.adjustType === 'percentage' ? '%' : ' €'} cada 2 reservas · nunca por debajo del ${r.minAdrFloorPct ?? 90}% del ADR semanal · un precio puesto a mano se respeta mientras tenga menos de ${silenceLabel}, pasado eso la regla vuelve a mandar`
    }
    if (r.ruleType === 'competitor_undercut') {
      return `"${rateName(r.referenceRateId)}" más cara que el competidor más barato (hoy+3 a hoy+21, ocupación < ${r.thresholdPct}%) → precio = competidor -${adj}%`
    }
    if (r.ruleType === 'sold_out_upsell') {
      return `"${roomTypeName(r.sourceRoomTypeId)}" a 0 disponibles (hoy a hoy+30) → baja "${roomTypeName(r.sourceRoomTypeId)}" para que "${roomTypeName(r.targetRoomTypeId)}" quede a su precio original + ${adj.toFixed(2)} €`
    }
    if (r.ruleType === 'evening_clearance_dip') {
      const startHour = r.clearanceStartHour ?? 20
      const overrideMin = r.clearanceOverrideMinutes ?? 60
      const overrideLabel = overrideMin % 60 === 0 ? `${overrideMin / 60}h` : `${overrideMin} min`
      return `Hoy desde las ${startHour}:00, si el precio > ADR semanal y ocupación < ${r.thresholdPct}% → -${adj}% por hora completa (cada reserva nueva retrasa 1h el siguiente escalón) · nunca por debajo del ${r.minAdrFloorPct ?? 100}% del ADR semanal · un precio puesto a mano se respeta mientras tenga menos de ${overrideLabel}, pasado eso la regla vuelve a mandar`
    }
    if (r.ruleType === 'booking_surge') {
      return `2+ reservas cuya estadía pase por esa noche en los últimos ${r.thresholdPct} min → +${fmtAdj} (se apaga sola en cuanto deja de haber 2+ recientes)`
    }
    return `Disponibilidad < ${r.thresholdPct}% → +${fmtAdj}`
  }

  return (
    <div>
      <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 16 }}>
        Las reglas activas ajustan automáticamente el precio de la tarifa raíz{rootName ? ` (${rootName})` : ''} (y por tanto el de todas las tarifas derivadas).
        "Disponibilidad baja" SUBE el precio cuando queda poca disponibilidad ese día. "Caída en lead time" BAJA el
        precio, pero solo del día que cae exactamente en hoy + el lead time medio de reservas de Booking.com de las
        últimas 4 semanas, si la ocupación de ese día concreto está floja. "Mínimos locales de ocupación" BAJA el
        precio en los valles de ocupación (incluye mesetas completas) entre hoy+3 y hoy+60. "Parada de reservas" BAJA el precio de forma
        progresiva en noches entre hoy y hoy+3 cuando pasan bloques de la ventana de silencio configurada (minutos, 4h/240min por
        defecto) sin ninguna reserva nueva cuya estadía pase por esa noche (no solo las que entran exactamente ese día; y su
        ocupación sigue por debajo del umbral) — un escalón por bloque, sin bajar nunca del suelo
        configurado (% del ADR real de esa semana; sin ADR real todavía, tope fijo del 30%). Cada 2 reservas nuevas
        de esa fecha sube medio escalón de vuelta, hasta recuperar el precio original — y si "Reservas seguidas" detecta
        un repunte en vivo para esa misma fecha, el descuento se retira del todo en el acto, sin esperar escalones. Un
        precio puesto a mano se respeta mientras sea más reciente que esa misma ventana de silencio; en cuanto la supera
        (sin reservas nuevas de por medio) se da por caducado y la regla vuelve a mandar sobre esa fecha.
        "Más cara que competidores" BAJA el precio de la tarifa
        de referencia elegida entre hoy+3 y hoy+21 cuando es más cara que el competidor activo más barato ese día y
        la ocupación está floja — el precio nuevo es el del competidor menos el % configurado, y nunca sube el precio
        vivo de una celda que otra regla de mayor prioridad tenga más rebajada. "Liquidación nocturna" BAJA el precio SOLO de hoy, solo a partir de la hora de inicio configurada, si el
        precio es mayor que el ADR real de esta semana y la ocupación de hoy sigue por debajo del umbral (100% por
        defecto: "hasta que se llene") — un escalón fijo por cada hora completa desde esa hora, calculado siempre
        sobre el precio original (no acumulativo), sin bajar nunca del suelo (% del ADR real semanal, 100% por
        defecto: nunca por debajo del propio ADR). Cada reserva nueva de hoy retrasa una hora el siguiente escalón,
        sin deshacer el descuento ya aplicado. Un precio puesto a mano se respeta mientras sea más reciente que su
        ventana de override configurada. "Venta de
        superiores" BAJA el precio del tipo de habitación que se agota (dentro de los próximos 30 días) en cuanto se
        queda a 0 unidades disponibles ese día, de forma que el tipo superior derivado de él quede a su precio
        original + el importe configurado — casi regala la subida de categoría en vez de perder la venta (también
        abarata los demás tipos derivados del que se agota). "Reservas seguidas" SUBE el precio de una noche en
        cuanto detecta 2 o más reservas hechas cuya estadía pase por ella (no solo las que entran exactamente ese
        día) dentro de la ventana de minutos configurada — sin memoria entre pasadas, así que se apaga sola en cuanto deja de haber 2+ reservas recientes dentro de esa
        ventana (por tiempo, o porque las reservas que la dispararon ya quedaron fuera de ella). Cada fecha la
        gobierna UNA sola regla: si varias se
        cumplen el mismo día, gana la de menor número de Prioridad y las demás quedan en suspenso esa fecha. El
        motor corre cada 30 minutos.
      </p>

      <table className="data-table" style={{ marginBottom: 24 }}>
        <thead><tr>
          <th title="Número menor = gana si varias reglas se cumplen la misma fecha">Prioridad</th><th>Nombre</th><th>Tipo</th><th>Condición</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>
          {rules.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text2)', textAlign: 'center' }}>Sin reglas</td></tr>}
          {rules.slice().sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.id - b.id).map(r => (
            <tr key={r.id}>
              <td style={{ fontWeight: 600 }}>{r.priority ?? 100}</td>
              <td>{r.name}</td>
              <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                {r.ruleType === 'lead_time_dip' ? 'Caída en lead time'
                  : r.ruleType === 'local_min_dip' ? 'Mínimos locales'
                  : r.ruleType === 'demand_pulse_dip' ? 'Parada de reservas'
                  : r.ruleType === 'competitor_undercut' ? 'Más cara que competidores'
                  : r.ruleType === 'sold_out_upsell' ? 'Venta de superiores'
                  : r.ruleType === 'evening_clearance_dip' ? 'Liquidación nocturna'
                  : r.ruleType === 'booking_surge' ? 'Reservas seguidas (sube precio)'
                  : 'Disponibilidad baja'}
              </td>
              <td style={{ fontSize: 13, color: 'var(--text2)' }}>{fmtRule(r)}</td>
              <td>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={r.active} onChange={() => toggle(r)} />
                  <span style={{ fontSize: 12 }}>{r.active ? 'Activa' : 'Inactiva'}</span>
                </label>
              </td>
              <td style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-ghost btn-xs" onClick={() => edit(r)}>✎</button>
                <button className="btn btn-ghost btn-xs" onClick={() => del(r.id, r.name)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>{editing ? `Editando: ${editing.name}` : 'Nueva regla'}</legend>
        <div className="form-grid">
          <div className="form-group"><label>Nombre *</label><input value={form.name} onChange={set('name')} placeholder="Última disponibilidad" /></div>
          <div className="form-group">
            <label>Prioridad</label>
            <input type="number" min="1" max="1000" value={form.priority} onChange={set('priority')} />
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>
              Número menor = gana. Si varias reglas se cumplen la misma fecha, solo se aplica la de menor número.
            </span>
          </div>
          <div className="form-group">
            <label>Tipo de regla</label>
            <select value={form.ruleType} onChange={setRuleType}>
              <option value="low_availability">Disponibilidad baja (sube precio)</option>
              <option value="lead_time_dip">Caída en día de lead time (baja precio)</option>
              <option value="local_min_dip">Mínimos locales de ocupación (baja precio)</option>
              <option value="demand_pulse_dip">Parada de reservas hoy-3d (baja precio progresivo)</option>
              <option value="competitor_undercut">Más cara que competidores (baja precio)</option>
              <option value="sold_out_upsell">Venta de superiores (baja precio)</option>
              <option value="evening_clearance_dip">Liquidación nocturna (baja precio)</option>
              <option value="booking_surge">Reservas seguidas (sube precio)</option>
            </select>
          </div>
          {form.ruleType !== 'sold_out_upsell' && (
            <div className="form-group">
              <label>
                {form.ruleType === 'low_availability' ? 'Umbral disponibilidad (%)'
                  : form.ruleType === 'evening_clearance_dip' ? 'Ocupación hasta la que actúa (%)'
                  : form.ruleType === 'booking_surge' ? 'Ventana de detección (minutos)'
                  : 'Umbral ocupación (%)'}
              </label>
              <input type="number" min="1" max={form.ruleType === 'booking_surge' ? 1440 : 100} value={form.thresholdPct} onChange={set('thresholdPct')} />
              {form.ruleType === 'booking_surge' && (
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>Se activa con 2 o más reservas para la misma fecha de entrada hechas dentro de esta ventana de minutos.</span>
              )}
            </div>
          )}
          {form.ruleType === 'competitor_undercut' && (
            <div className="form-group">
              <label>Tarifa de referencia</label>
              <select value={form.referenceRateId} onChange={set('referenceRateId')}>
                <option value="">Elige una tarifa…</option>
                {allRates.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>La que se compara contra los competidores y se ajusta.</span>
            </div>
          )}
          {form.ruleType === 'sold_out_upsell' && (
            <>
              <div className="form-group">
                <label>Tipo de habitación que se agota</label>
                <select value={form.sourceRoomTypeId} onChange={set('sourceRoomTypeId')}>
                  <option value="">Elige un tipo…</option>
                  {allRoomTypes.map((rt: any) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Tipo superior (derivado del que se agota)</label>
                <select value={form.targetRoomTypeId} onChange={set('targetRoomTypeId')}>
                  <option value="">Elige un tipo…</option>
                  {allRoomTypes.map((rt: any) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
                </select>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>Debe derivar del tipo que se agota. Se baja el precio de ESE tipo (agotado, no pierde ventas) y el superior lo sigue; también arrastra a otros tipos derivados de él.</span>
              </div>
            </>
          )}
          {form.ruleType !== 'competitor_undercut' && form.ruleType !== 'sold_out_upsell' && form.ruleType !== 'evening_clearance_dip' && form.ruleType !== 'booking_surge' && (
            <div className="form-group">
              <label>Tipo de ajuste</label>
              <select value={form.adjustType} onChange={set('adjustType')}>
                <option value="percentage">Porcentaje (%)</option>
                <option value="fixed">Fijo (€)</option>
              </select>
            </div>
          )}
          <div className="form-group">
            <label>
              {form.ruleType === 'low_availability' ? 'Valor (siempre suma)'
                : form.ruleType === 'demand_pulse_dip' ? 'Escalón de bajada (la subida es la mitad)'
                : form.ruleType === 'competitor_undercut' ? 'Descuento sobre el precio del competidor (%)'
                : form.ruleType === 'sold_out_upsell' ? 'Importe sobre el precio original del tipo que se agota (€)'
                : form.ruleType === 'evening_clearance_dip' ? 'Escalón de bajada por hora (%)'
                : form.ruleType === 'booking_surge' ? 'Subida del precio (%, siempre suma)'
                : 'Valor (siempre resta)'}
            </label>
            <input type="number" min="0" step="0.01" value={form.adjustValue} onChange={set('adjustValue')} />
          </div>
          {form.ruleType === 'demand_pulse_dip' && (
            <div className="form-group">
              <label>Suelo de precio (% del ADR semanal)</label>
              <input type="number" min="1" max="100" value={form.minAdrFloorPct} onChange={set('minAdrFloorPct')} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                Nunca baja de este % del ADR real de esa semana (si aún no hay ADR real, tope fijo del 30%)
              </span>
            </div>
          )}
          {form.ruleType === 'demand_pulse_dip' && (
            <div className="form-group">
              <label>Ventana de silencio (minutos)</label>
              <input type="number" min="1" max="1440" value={form.pulseSilenceMinutes} onChange={set('pulseSilenceMinutes')} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                Minutos sin reservas nuevas para sumar un escalón de bajada. También es cuánto se respeta un precio
                puesto a mano: mientras el override tenga menos de esta ventana, la regla no lo toca; pasada, lo
                da por caducado y vuelve a mandar sobre esa fecha.
              </span>
            </div>
          )}
          {form.ruleType === 'evening_clearance_dip' && (
            <div className="form-group">
              <label>Suelo de precio (% del ADR semanal)</label>
              <input type="number" min="1" max="200" value={form.minAdrFloorPct} onChange={set('minAdrFloorPct')} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                Nunca baja de este % del ADR real de esa semana — 100% = nunca por debajo del propio ADR. Si esa
                semana no tiene ADR real todavía, la regla no actúa ese día.
              </span>
            </div>
          )}
          {form.ruleType === 'evening_clearance_dip' && (
            <div className="form-group">
              <label>Hora de inicio (0-23, Europe/Madrid)</label>
              <input type="number" min="0" max="23" value={form.clearanceStartHour} onChange={set('clearanceStartHour')} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                La regla no actúa ningún día antes de esta hora.
              </span>
            </div>
          )}
          {form.ruleType === 'evening_clearance_dip' && (
            <div className="form-group">
              <label>Ventana de override manual (minutos)</label>
              <input type="number" min="1" max="1440" value={form.clearanceOverrideMinutes} onChange={set('clearanceOverrideMinutes')} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                Un precio puesto a mano se respeta mientras tenga menos de esta antigüedad; pasada, la regla vuelve
                a mandar sobre esa fecha.
              </span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Guardar cambios' : '+ Añadir'}</button>
          {editing && <button className="btn btn-ghost" onClick={cancel}>Cancelar</button>}
        </div>
      </fieldset>
    </div>
  )
}

// ─── Configuración: derivación de precio por tipo de habitación ────────────────
// Ej.: "Individual" = "Doble" -12%, para TODAS las tarifas por igual — se
// calcula solo, sin necesidad de rellenar un calendario de precios propio.

function RoomTypeDerivationPanel({ roomTypeList, onChanged }: { roomTypeList: any[]; onChanged: () => void }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginBottom: 4 }}>Derivación de precio por tipo de habitación</h3>
      <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 16 }}>
        Un tipo de habitación puede derivar su precio de otro (con un ajuste en % o €), igual para todas las tarifas.
        El tipo base sigue siendo el único con calendario de precios editable — el derivado se calcula solo.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {roomTypeList.map(rt => (
          <RoomTypeDerivationRow key={rt.id} roomType={rt} roomTypeList={roomTypeList} onChanged={onChanged} />
        ))}
      </div>
    </div>
  )
}

function RoomTypeDerivationRow({ roomType, roomTypeList, onChanged }: { roomType: any; roomTypeList: any[]; onChanged: () => void }) {
  const [baseRoomTypeId, setBaseRoomTypeId] = useState(roomType.baseRoomTypeId ? String(roomType.baseRoomTypeId) : '')
  const [adjustType,      setAdjustType]     = useState(roomType.adjustType ?? 'percentage')
  const [adjustValue,     setAdjustValue]    = useState(roomType.adjustValue ?? '0')
  const [saving,          setSaving]         = useState(false)

  const baseOptions = roomTypeList.filter(t => t.id !== roomType.id)

  const save = async () => {
    setSaving(true)
    try {
      await api.updateRoomType(roomType.id, {
        baseRoomTypeId: baseRoomTypeId ? Number(baseRoomTypeId) : null,
        adjustType:     baseRoomTypeId ? adjustType : null,
        adjustValue:    baseRoomTypeId ? (parseFloat(adjustValue) || 0) : null,
      })
      toast('Guardado')
      onChanged()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ minWidth: 140, fontWeight: 600, fontSize: 13 }}>{roomType.name}</div>
      <select value={baseRoomTypeId} onChange={e => setBaseRoomTypeId(e.target.value)} style={{ width: 180 }}>
        <option value="">— Precio propio (editable) —</option>
        {baseOptions.map(t => <option key={t.id} value={t.id}>Deriva de: {t.name}</option>)}
      </select>
      {baseRoomTypeId && <>
        <select value={adjustType} onChange={e => setAdjustType(e.target.value)} style={{ width: 130 }}>
          <option value="percentage">Porcentaje (%)</option>
          <option value="amount">Importe (+€)</option>
          <option value="fixed">Fijo (€)</option>
        </select>
        <input type="number" step="0.01" value={adjustValue} onChange={e => setAdjustValue(e.target.value)}
          style={{ width: 90 }} placeholder="ej. -12" />
      </>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>Guardar</button>
    </div>
  )
}

// ─── Promociones Web — reenganche de reservas canceladas ──────────────────────

function CancellationRecoveryPanel() {
  const { user } = useAuth()
  const admin = canManage(user)

  const [cfg,     setCfg]     = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    api.getCancellationRecoverySettings().then((r: any) => { setCfg(r.data); setLoading(false) })
  }, [])

  const set = (field: string, value: any) => setCfg((c: any) => ({ ...c, [field]: value }))

  const save = async () => {
    setSaving(true)
    try {
      await api.updateCancellationRecoverySettings(cfg)
      toast('Configuración guardada')
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="loading">Cargando…</div>
  if (!cfg)    return null

  return (
    <div style={{ maxWidth: 640, marginBottom: 28 }}>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Reenganche de reservas canceladas</div>
            <div style={{ color: 'var(--text2)', fontSize: 13, marginTop: 3 }}>
              Detecta cancelaciones recientes con email real (no el alias @guest.booking.com) y ofrece
              un descuento por email/WhatsApp para volver a reservar la misma tarifa
            </div>
          </div>
          <label className="rate-toggle" style={{ marginLeft: 16 }}>
            <input type="checkbox" checked={cfg.enabled} disabled={!admin}
              onChange={e => set('enabled', e.target.checked)} />
            <span className="rate-toggle-slider" />
          </label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Tiempos</div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div className="form-group">
            <label>Esperar antes de enviar (h)</label>
            <input type="number" min={0} max={168} value={cfg.minAgeHours} disabled={!admin}
              onChange={e => set('minAgeHours', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Da margen a un cancel accidental</span>
          </div>
          <div className="form-group">
            <label>Ignorar si canceló hace más de (h)</label>
            <input type="number" min={1} max={720} value={cfg.maxAgeHours} disabled={!admin}
              onChange={e => set('maxAgeHours', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>No reenganchar cancelaciones antiguas</span>
          </div>
          <div className="form-group">
            <label>Validez del enlace de descuento (h)</label>
            <input type="number" min={1} max={720} value={cfg.validityHours} disabled={!admin}
              onChange={e => set('validityHours', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Tras expirar, el descuento no aplica</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Descuento</div>
        <div className="form-group" style={{ maxWidth: 160 }}>
          <label>% de descuento</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" min={1} max={99} value={cfg.discountPct} disabled={!admin}
              onChange={e => set('discountPct', Number(e.target.value))} />
            <span style={{ color: 'var(--text2)', fontSize: 13 }}>%</span>
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 10, marginBottom: 0 }}>
          Se aplica sobre el <strong>menor</strong> entre lo que pagaba la reserva cancelada y lo que costaría
          hoy esa misma estancia con la misma tarifa — nunca se ofrece un precio más caro que el original.
        </p>
      </div>

      {admin && (
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </button>
      )}
    </div>
  )
}

// ─── Promociones Web — configuración de recuperación de carritos ──────────────

type DiscountTier = { threshold: number; pct: number }

function CartRecoveryPanel() {
  const { user } = useAuth()
  const admin = canManage(user)

  const [cfg,     setCfg]     = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [tiers,   setTiers]   = useState<DiscountTier[]>([])

  useEffect(() => {
    api.getCartRecoverySettings().then((r: any) => {
      setCfg(r.data)
      setTiers((r.data.discountTiers ?? []).slice().sort((a: DiscountTier, b: DiscountTier) => b.threshold - a.threshold))
      setLoading(false)
    })
  }, [])

  const set = (field: string, value: any) => setCfg((c: any) => ({ ...c, [field]: value }))

  const save = async () => {
    setSaving(true)
    try {
      const sorted = [...tiers].sort((a, b) => b.threshold - a.threshold)
      await api.updateCartRecoverySettings({ ...cfg, discountTiers: sorted })
      toast('Configuración guardada')
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const addTier = () => setTiers(t => [...t, { threshold: 0, pct: 10 }])
  const removeTier = (i: number) => setTiers(t => t.filter((_, j) => j !== i))
  const updateTier = (i: number, field: 'threshold' | 'pct', val: number) =>
    setTiers(t => t.map((row, j) => j === i ? { ...row, [field]: val } : row))

  if (loading) return <div className="loading">Cargando…</div>
  if (!cfg)    return null

  const fmtEur = (n: number) => n === 0 ? 'cualquier importe' : `más de ${n.toLocaleString('es-ES')} €`

  return (
    <div style={{ maxWidth: 640 }}>
      {/* Toggle general */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Recuperación de carritos abandonados</div>
            <div style={{ color: 'var(--text2)', fontSize: 13, marginTop: 3 }}>
              Detecta reservas web sin pagar y envía un email/WhatsApp con descuento
            </div>
          </div>
          <label className="rate-toggle" style={{ marginLeft: 16 }}>
            <input type="checkbox" checked={cfg.enabled} disabled={!admin}
              onChange={e => set('enabled', e.target.checked)} />
            <span className="rate-toggle-slider" />
          </label>
        </div>
      </div>

      {/* Tiempos */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Tiempos</div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div className="form-group">
            <label>Esperar antes de detectar (min)</label>
            <input type="number" min={1} max={1440} value={cfg.minAgeMin} disabled={!admin}
              onChange={e => set('minAgeMin', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>El usuario puede estar aún pagando</span>
          </div>
          <div className="form-group">
            <label>Ignorar si lleva más de (horas)</label>
            <input type="number" min={1} max={168} value={cfg.maxAgeHours} disabled={!admin}
              onChange={e => set('maxAgeHours', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>No recuperar carritos muy antiguos</span>
          </div>
          <div className="form-group">
            <label>Validez del enlace de descuento (h)</label>
            <input type="number" min={1} max={168} value={cfg.validityHours} disabled={!admin}
              onChange={e => set('validityHours', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Tras expirar, el descuento no aplica</span>
          </div>
        </div>
      </div>

      {/* Tramos de descuento */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontWeight: 600 }}>Tramos de descuento</div>
          {admin && <button className="btn btn-ghost btn-sm" onClick={addTier}>+ Añadir tramo</button>}
        </div>
        <table className="data-table" style={{ marginBottom: 0 }}>
          <thead><tr>
            <th>Si el importe supera…</th>
            <th>Descuento ofrecido</th>
            {admin && <th></th>}
          </tr></thead>
          <tbody>
            {[...tiers]
              .sort((a, b) => b.threshold - a.threshold)
              .map((tier, i) => (
                <tr key={i}>
                  <td>
                    {admin
                      ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="number" min={0} value={tier.threshold} style={{ width: 100 }}
                            onChange={e => updateTier(i, 'threshold', Number(e.target.value))} />
                          <span style={{ color: 'var(--text2)', fontSize: 13 }}>€</span>
                        </div>
                      : <span>{fmtEur(tier.threshold)}</span>}
                  </td>
                  <td>
                    {admin
                      ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="number" min={1} max={99} value={tier.pct} style={{ width: 70 }}
                            onChange={e => updateTier(i, 'pct', Number(e.target.value))} />
                          <span style={{ color: 'var(--text2)', fontSize: 13 }}>%</span>
                        </div>
                      : <strong>{tier.pct}%</strong>}
                  </td>
                  {admin && (
                    <td>
                      {tiers.length > 1 && (
                        <button className="btn btn-ghost btn-sm" onClick={() => removeTier(i)}
                          style={{ color: 'var(--red)' }}>Eliminar</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 10 }}>
          El tramo con umbral 0 € actúa como descuento base para cualquier importe que no supere los otros umbrales.
        </p>
      </div>

      {/* Criterios de captación de lead */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Criterios de cliente nuevo</div>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
          La oferta solo se envía si el huésped cumple <strong>todos</strong> los criterios activos.
          Sirve para asegurarse de que solo reciben el descuento clientes que no tenemos registrados.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { key: 'targetNewPhone',  label: 'El teléfono no existe en ningún otro perfil de huésped' },
            { key: 'targetNewName',   label: 'El nombre y apellido normalizados no existen en ningún otro perfil' },
            { key: 'targetFirstTime', label: 'Sin reservas anteriores completadas (primer contacto directo)' },
          ].map(({ key, label }) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: admin ? 'pointer' : 'default', fontSize: 14 }}>
              <input type="checkbox" checked={cfg[key]} disabled={!admin}
                onChange={e => set(key, e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {admin && (
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </button>
      )}
    </div>
  )
}

// ─── Promociones Web — descuento temporal en la propia página de reserva ──────
// Distinto de los dos anteriores: no manda nada por email, vive entero dentro
// de la sesión de reserva en curso — se activa a los X minutos de que el
// cliente rellene sus datos, y solo es válido Y minutos más desde entonces.

function TemporaryDiscountPanel() {
  const { user } = useAuth()
  const admin = canManage(user)

  const [cfg,     setCfg]     = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    api.getTemporaryDiscountSettings().then((r: any) => { setCfg(r.data); setLoading(false) })
  }, [])

  const set = (field: string, value: any) => setCfg((c: any) => ({ ...c, [field]: value }))

  const save = async () => {
    setSaving(true)
    try {
      await api.updateTemporaryDiscountSettings(cfg)
      toast('Configuración guardada')
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="loading">Cargando…</div>
  if (!cfg)    return null

  return (
    <div style={{ maxWidth: 640, marginBottom: 28 }}>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Descuento temporal en la reserva</div>
            <div style={{ color: 'var(--text2)', fontSize: 13, marginTop: 3 }}>
              Aparece solo dentro de la propia página de reserva (nada por email): se activa a los
              pocos minutos de que el cliente rellene sus datos, con una ventana limitada para pagar
              y que el descuento se aplique de verdad.
            </div>
          </div>
          <label className="rate-toggle" style={{ marginLeft: 16 }}>
            <input type="checkbox" checked={cfg.enabled} disabled={!admin}
              onChange={e => set('enabled', e.target.checked)} />
            <span className="rate-toggle-slider" />
          </label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Tiempos</div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="form-group">
            <label>Activar a los (min)</label>
            <input type="number" min={1} max={120} value={cfg.activationMinutes} disabled={!admin}
              onChange={e => set('activationMinutes', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Desde que rellena email + nombre</span>
          </div>
          <div className="form-group">
            <label>Ventana para completar (min)</label>
            <input type="number" min={1} max={240} value={cfg.windowMinutes} disabled={!admin}
              onChange={e => set('windowMinutes', Number(e.target.value))} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Desde que se activa — pasado esto, ya no aplica</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 14 }}>Descuento</div>
        <div className="form-group" style={{ maxWidth: 160 }}>
          <label>% de descuento</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" min={1} max={99} value={cfg.discountPct} disabled={!admin}
              onChange={e => set('discountPct', Number(e.target.value))} />
            <span style={{ color: 'var(--text2)', fontSize: 13 }}>%</span>
          </div>
        </div>
      </div>

      {admin && (
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </button>
      )}
    </div>
  )
}

function OperatorsModal({ operators, onClose, onSaved }:
  { operators: Operator[]; onClose: () => void; onSaved: () => void }) {
  const [name,    setName]    = useState('')
  const [code,    setCode]    = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [saving,  setSaving]  = useState(false)

  const add = async () => {
    if (!name.trim() || !code.trim()) { toast('Nombre y código son obligatorios', 'err'); return }
    setSaving(true)
    try {
      await api.createOperator({ name: name.trim(), code: code.trim(), logoUrl: logoUrl.trim() || undefined })
      toast('Operador añadido'); onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title="Operadores" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cerrar</button>
        <button className="btn btn-primary" onClick={add} disabled={saving}>+ Añadir operador</button></>
    }>
      <div style={{ marginBottom: 12 }}>
        {operators.length === 0
          ? <p style={{ color: 'var(--text2)', fontSize: 13 }}>No hay operadores</p>
          : operators.map(o => {
            const c = opColor(o.code)
            return (
              <div key={o.id} className="op-row">
                <span className="op-chip" style={{ background: c.bg, color: c.color }}>{o.name}</span>
                <span style={{ color: 'var(--text2)', fontSize: 12 }}>{o.code}</span>
              </div>
            )
          })}
      </div>
      <hr style={{ borderColor: 'var(--border)', margin: '12px 0' }} />
      <div className="form-grid">
        <div className="form-group"><label>Nombre</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Booking.com" /></div>
        <div className="form-group"><label>Código</label><input value={code} onChange={e => setCode(e.target.value)} placeholder="booking" /></div>
        <div className="form-group full"><label>URL logo</label><input value={logoUrl} onChange={e => setLogoUrl(e.target.value)} placeholder="https://…" /></div>
      </div>
    </Modal>
  )
}
