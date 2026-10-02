import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth, hasRole, canManage } from '../contexts/AuthContext'

const STATUS_CFG = {
  listas:   { label: 'Listas',   icon: '✓',  color: 'var(--green)',           bg: 'rgba(34,197,94,.15)'  },
  tendidas: { label: 'Tendidas', icon: '〜', color: 'var(--blue, #3b82f6)',   bg: 'rgba(59,130,246,.15)' },
  en_agua:  { label: 'En agua',  icon: '💧', color: 'var(--yellow, #d97706)', bg: 'rgba(245,158,11,.15)' },
  sucias:   { label: 'Sucias',   icon: '✗',  color: 'var(--red, #ef4444)',    bg: 'rgba(239,68,68,.15)'  },
  rotas:    { label: 'Rotas',    icon: '🗑',  color: 'var(--text3)',           bg: 'rgba(120,120,130,.15)' },
} as const

const ITEM_CFG = {
  shower:  { label: 'Ducha',   icon: '🚿' },
  manos:   { label: 'Manos',   icon: '🖐' },
  sabanas: { label: 'Sábanas', icon: '🛏' },
  pies:    { label: 'Pies',    icon: '👣' },
} as const

type StatusKey   = keyof typeof STATUS_CFG
type ItemTypeKey = keyof typeof ITEM_CFG

const STATUS_ORDER: StatusKey[]   = ['listas', 'tendidas', 'en_agua', 'sucias', 'rotas']
const ITEM_ORDER:   ItemTypeKey[] = ['shower', 'manos', 'sabanas', 'pies']

type ProcessGrid = Record<StatusKey, Record<ItemTypeKey, number>>

function emptyGrid(): ProcessGrid {
  return {
    listas:   { shower: 0, manos: 0, sabanas: 0, pies: 0 },
    tendidas: { shower: 0, manos: 0, sabanas: 0, pies: 0 },
    en_agua:  { shower: 0, manos: 0, sabanas: 0, pies: 0 },
    sucias:   { shower: 0, manos: 0, sabanas: 0, pies: 0 },
    rotas:    { shower: 0, manos: 0, sabanas: 0, pies: 0 },
  }
}

function gridToItems(grid: ProcessGrid) {
  const items: { itemType: string; status: string; count: number }[] = []
  for (const status of STATUS_ORDER)
    for (const itemType of ITEM_ORDER) {
      const count = grid[status][itemType]
      if (count > 0) items.push({ status, itemType, count })
    }
  return items
}

function gridTotal(grid: ProcessGrid): number {
  return STATUS_ORDER.reduce((s, st) => s + ITEM_ORDER.reduce((s2, it) => s2 + grid[st][it], 0), 0)
}

interface StaffUser   { id: number; name: string }
interface ProcessItem { itemType: string; status: string; count: number }

interface ProcessBatch {
  id: number
  processedById: number
  processedByName: string
  distributionLocation: string
  processedAt: string
  items: ProcessItem[]
}

interface Delivery {
  id: number; date: string
  deliveredById: number;  deliveredByName: string
  deliveredAt: string
  location: string
  deliveredToId: number;  deliveredToName: string
  showerTowels: number;   handTowels: number
  sheetSets: number;      footTowels: number
  notes: string | null
  recipientStatus: string | null
  recipientNote: string | null
  recipientConfirmedAt: string | null
  discrepancyAckAt: string | null
  discrepancyAckBy: number | null
}

interface Suggest { showerTowels: number; handTowels: number; sheetSets: number; footTowels: number; rooms: number }

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

// ── Chip de cantidad ──────────────────────────────────────────────────────────
function ItemChip({ icon, val, label, highlight }: { icon: string; val: number; label: string; highlight?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '2px 7px', borderRadius: 8, fontSize: 12, fontWeight: 600,
      background: highlight && val > 0 ? 'rgba(99,102,241,.12)' : val === 0 ? 'var(--bg3,var(--bg2))' : 'rgba(99,102,241,.08)',
      color: val === 0 ? 'var(--text3)' : 'var(--text1)',
      border: '1px solid var(--border)',
    }}>
      {icon} {val}
    </span>
  )
}

// ── Fila compacta de una entrega ──────────────────────────────────────────────
function DeliveryRow({
  d, myId, isAdminUser, staff, onRefresh, onDelete,
}: {
  d: Delivery; myId: number | undefined; isAdminUser: boolean
  staff: StaffUser[]; onRefresh(): void; onDelete(id: number): void
}) {
  const [expanded, setExpanded]   = useState(false)
  const [confirming, setConfirm]  = useState(false)
  const [discNote,  setDiscNote]  = useState('')
  const [saving,    setSaving]    = useState(false)

  // edición
  const [editing,      setEditing]     = useState(false)
  const [eShower, setEShower] = useState(d.showerTowels)
  const [eHand,   setEHand]   = useState(d.handTowels)
  const [eSheets, setESheets] = useState(d.sheetSets)
  const [eFoot,   setEFoot]   = useState(d.footTowels)
  const [eLoc,    setELoc]    = useState(d.location)
  const [eTo,     setETo]     = useState<number>(d.deliveredToId)
  const [eNotes,  setENotes]  = useState(d.notes ?? '')
  const [eSaving, setESaving] = useState(false)

  const canEdit = d.deliveredById === myId || isAdminUser
  const isMyReceipt = d.deliveredToId === myId

  const inp: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg2)', color: 'var(--text1)', fontSize: 13, width: '100%', boxSizing: 'border-box',
  }

  async function apiFetch(path: string, opts?: RequestInit) {
    const r = await fetch(path, { credentials: 'include', ...opts })
    const b = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(typeof b.error === 'string' ? b.error : (b.message ?? `Error ${r.status}`))
    return b
  }

  async function confirmReceipt(status: 'ok' | 'discrepancy') {
    setSaving(true)
    try {
      await apiFetch(`/api/laundry/${d.id}/confirm`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note: discNote || null }),
      })
      onRefresh()
    } catch { /* silencioso */ }
    finally { setSaving(false); setConfirm(false) }
  }

  async function saveEdit() {
    setESaving(true)
    try {
      await apiFetch(`/api/laundry/${d.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: eLoc, deliveredToId: eTo, showerTowels: eShower, handTowels: eHand, sheetSets: eSheets, footTowels: eFoot, notes: eNotes || null }),
      })
      setEditing(false); onRefresh()
    } catch { /* silencioso */ }
    finally { setESaving(false) }
  }

  const discResolved = d.recipientStatus === 'discrepancy' && !!d.discrepancyAckAt
  const discPending  = d.recipientStatus === 'discrepancy' && !d.discrepancyAckAt

  const statusBadge = d.recipientStatus === 'ok'
    ? <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: 'rgba(34,197,94,.12)', color: 'var(--green)', border: '1px solid rgba(34,197,94,.3)' }}>✓ OK</span>
    : discPending
    ? <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: 'rgba(239,68,68,.12)', color: 'var(--red,#ef4444)', border: '1px solid rgba(239,68,68,.4)', animation: 'pulse 2s infinite' }} title={d.recipientNote ?? ''}>⚠ Disc. pendiente</span>
    : discResolved
    ? <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: 'rgba(245,158,11,.10)', color: 'var(--yellow,#d97706)', border: '1px solid rgba(245,158,11,.3)' }} title={d.recipientNote ?? ''}>⚠ Disc. resuelta</span>
    : <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 11, color: 'var(--text3)', border: '1px solid var(--border)' }}>Pendiente</span>

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-card,var(--bg2))', overflow: 'hidden' }}>
      {/* Cabecera: dos líneas para evitar desbordamiento horizontal */}
      <div style={{ padding: '8px 10px', cursor: 'pointer' }}
        onClick={() => { if (!editing) setExpanded(e => !e) }}>
        {/* Línea 1: metadatos + flecha */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>{fmtTime(d.deliveredAt)}</span>
          <span style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>{d.deliveredByName.split(' ')[0]}</span>
          <span style={{ fontSize: 11, color: 'var(--text2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            → {d.deliveredToName.split(' ')[0]} · {d.location}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        </div>
        {/* Línea 2: chips + badge (con wrap por si acaso) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <ItemChip icon="🚿" val={d.showerTowels} label="ducha" />
          <ItemChip icon="🖐" val={d.handTowels}   label="manos" />
          <ItemChip icon="🛏" val={d.sheetSets}    label="sáb." />
          <ItemChip icon="👣" val={d.footTowels}   label="pies" />
          <div style={{ marginLeft: 'auto' }} onClick={e => e.stopPropagation()}>{statusBadge}</div>
        </div>
      </div>

      {/* Sección expandida */}
      {expanded && (
        <div style={{ padding: '0 10px 10px', borderTop: '1px solid var(--border)' }}>
          {d.notes && <div style={{ fontSize: 12, color: 'var(--text2)', padding: '6px 0' }}>📝 {d.notes}</div>}

          {/* Banner de discrepancia pendiente de reconocer — visible para el entregador */}
          {discPending && (
            <div style={{
              margin: '8px 0', padding: '10px 12px', borderRadius: 8,
              background: 'rgba(239,68,68,.08)', border: '2px solid rgba(239,68,68,.4)',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red,#ef4444)' }}>
                ⚠ Discrepancia reportada por {d.deliveredToName}
              </div>
              {d.recipientNote && (
                <div style={{ fontSize: 12, color: 'var(--text1)', background: 'var(--bg2)', padding: '6px 10px', borderRadius: 6, borderLeft: '3px solid rgba(239,68,68,.5)' }}>
                  "{d.recipientNote}"
                </div>
              )}
              {(d.deliveredById === myId || isAdminUser) && (
                <button onClick={async () => {
                  setSaving(true)
                  try {
                    await apiFetch(`/api/laundry/${d.id}/ack-discrepancy`, { method: 'PATCH' })
                    onRefresh()
                  } catch { /* silencioso */ }
                  finally { setSaving(false) }
                }} disabled={saving}
                  style={{ alignSelf: 'flex-start', padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(239,68,68,.5)', background: 'rgba(239,68,68,.1)', color: 'var(--red,#ef4444)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  {saving ? '…' : 'He visto la discrepancia — reconocer'}
                </button>
              )}
            </div>
          )}

          {/* Discrepancia ya resuelta — mostrar nota e info de resolución */}
          {discResolved && (
            <div style={{
              margin: '8px 0', padding: '8px 12px', borderRadius: 8,
              background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.3)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--yellow,#d97706)', marginBottom: 4 }}>
                ⚠ Discrepancia resuelta
              </div>
              {d.recipientNote && <div style={{ fontSize: 12, color: 'var(--text2)' }}>"{d.recipientNote}"</div>}
            </div>
          )}

          {/* Confirmación de recepción */}
          {(isMyReceipt || isAdminUser) && !d.recipientStatus && (
            <div style={{ paddingTop: 8 }}>
              {!confirming ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => confirmReceipt('ok')} disabled={saving}
                    style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(34,197,94,.4)', background: 'rgba(34,197,94,.08)', color: 'var(--green)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    ✓ Confirmar OK
                  </button>
                  <button onClick={() => setConfirm(true)}
                    style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(245,158,11,.4)', background: 'rgba(245,158,11,.08)', color: 'var(--yellow,#d97706)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    ⚠ Discrepancia
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input autoFocus value={discNote} onChange={e => setDiscNote(e.target.value)}
                    placeholder="Describe la discrepancia…"
                    style={{ ...inp, fontSize: 12 }} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => confirmReceipt('discrepancy')} disabled={saving || !discNote.trim()}
                      style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(245,158,11,.5)', background: 'rgba(245,158,11,.12)', color: 'var(--yellow,#d97706)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {saving ? '…' : 'Confirmar discrepancia'}
                    </button>
                    <button onClick={() => { setConfirm(false); setDiscNote('') }}
                      style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Acciones */}
          {!editing && (
            <div style={{ display: 'flex', gap: 6, paddingTop: 8 }}>
              {canEdit && (
                <button onClick={() => setEditing(true)}
                  style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>
                  ✏ Editar
                </button>
              )}
              {(d.deliveredById === myId || isAdminUser) && (
                <button onClick={() => onDelete(d.id)}
                  style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--red,#ef4444)', fontSize: 12, cursor: 'pointer' }}>
                  ✕ Eliminar
                </button>
              )}
            </div>
          )}

          {/* Formulario de edición inline */}
          {editing && (
            <div style={{ paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* minmax(0,1fr) fuerza que cada columna pueda encoger por debajo de min-content */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8 }}>
                {([['🚿','Ducha',eShower,setEShower],['🖐','Manos',eHand,setEHand],['🛏','Sábanas',eSheets,setESheets],['👣','Pies',eFoot,setEFoot]] as const).map(([icon,lbl,val,set]) => (
                  <div key={lbl} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 3, textAlign: 'center' }}>{icon} {lbl}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <button type="button" onClick={() => (set as any)(Math.max(0, (val as number) - 1))}
                        style={{ width: 28, height: 32, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg)', cursor: 'pointer', fontSize: 14, color: 'var(--text1)' }}>−</button>
                      <input type="number" min={0} value={val}
                        onChange={e => (set as any)(Math.max(0, Number(e.target.value)))}
                        style={{ flex: 1, minWidth: 0, width: 0, textAlign: 'center', fontWeight: 700, fontSize: 15, padding: '4px 2px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', boxSizing: 'border-box' }} />
                      <button type="button" onClick={() => (set as any)((val as number) + 1)}
                        style={{ width: 28, height: 32, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg)', cursor: 'pointer', fontSize: 14, color: 'var(--text1)' }}>+</button>
                    </div>
                  </div>
                ))}
              </div>
              {/* Lugar y Para: columna única para evitar overflow en móvil */}
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Lugar</div>
                <input style={inp} value={eLoc} onChange={e => setELoc(e.target.value)} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Para</div>
                <select style={{ ...inp, cursor: 'pointer' }} value={eTo} onChange={e => setETo(Number(e.target.value))}>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Notas</div>
                <input style={{ ...inp, fontSize: 12 }} value={eNotes} onChange={e => setENotes(e.target.value)} placeholder="Observaciones…" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" style={{ flex: 1 }} disabled={eSaving || !eLoc.trim()} onClick={saveEdit}>
                  {eSaving ? 'Guardando…' : 'Guardar'}
                </button>
                <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancelar</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Resumen diario ────────────────────────────────────────────────────────────
function DaySummary({ deliveries, batches, myId, isAdminUser }: {
  deliveries: Delivery[]; batches: ProcessBatch[]
  myId: number | undefined; isAdminUser: boolean
}) {
  const scope = isAdminUser ? deliveries : deliveries.filter(d => d.deliveredToId === myId || d.deliveredById === myId)

  const totRecv = scope.reduce((s, d) => ({
    shower: s.shower + d.showerTowels,
    hand:   s.hand   + d.handTowels,
    sheets: s.sheets + d.sheetSets,
    foot:   s.foot   + d.footTowels,
  }), { shower: 0, hand: 0, sheets: 0, foot: 0 })

  const discPendingAck = scope.filter(d => d.recipientStatus === 'discrepancy' && !d.discrepancyAckAt)
  const discResolved   = scope.filter(d => d.recipientStatus === 'discrepancy' && !!d.discrepancyAckAt)
  const pending        = scope.filter(d => !d.recipientStatus)

  // procesado declarado (solo batches del scope)
  const scopeBatches = isAdminUser ? batches : batches.filter(b => b.processedById === myId)
  const totProc:         Record<StatusKey, number>                        = { listas: 0, tendidas: 0, en_agua: 0, sucias: 0, rotas: 0 }
  const totProcByItem:   Record<ItemTypeKey, number>                      = { shower: 0, manos: 0, sabanas: 0, pies: 0 }
  const totProcDetail:   Record<StatusKey, Partial<Record<ItemTypeKey, number>>> = { listas: {}, tendidas: {}, en_agua: {}, sucias: {}, rotas: {} }
  for (const b of scopeBatches)
    for (const item of b.items) {
      const st = item.status as StatusKey
      const it = item.itemType as ItemTypeKey
      totProc[st]         = (totProc[st]         ?? 0) + item.count
      totProcByItem[it]   = (totProcByItem[it]   ?? 0) + item.count
      totProcDetail[st][it] = (totProcDetail[st][it] ?? 0) + item.count
    }

  const totalRecv   = totRecv.shower + totRecv.hand + totRecv.sheets + totRecv.foot
  const totalListas = totProc.listas

  // Discrepancias por tipo: recibido − declarado en batches (cualquier estado)
  // recv usa: shower→shower, hand→manos, sheets→sabanas, foot→pies
  const discByItem: Record<ItemTypeKey, number> = {
    shower:  totRecv.shower - totProcByItem.shower,
    manos:   totRecv.hand   - totProcByItem.manos,
    sabanas: totRecv.sheets - totProcByItem.sabanas,
    pies:    totRecv.foot   - totProcByItem.pies,
  }
  const hasDisc = Object.values(discByItem).some(v => v !== 0)

  if (scope.length === 0 && scopeBatches.length === 0) return null

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text3)', marginBottom: 10 }}>
        Resumen del día
      </div>

      {/* Volumen recibido */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text2)', minWidth: 80, flexShrink: 0 }}>Recibido:</span>
        {([['🚿', totRecv.shower], ['🖐', totRecv.hand], ['🛏', totRecv.sheets], ['👣', totRecv.foot]] as [string,number][]).map(([icon, val]) => (
          <span key={icon} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 8px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: val > 0 ? 'rgba(99,102,241,.1)' : 'transparent',
            color: val > 0 ? 'var(--text1)' : 'var(--text3)',
            border: '1px solid var(--border)',
          }}>
            {icon} {val}
          </span>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 4 }}>= {totalRecv} uds.</span>
      </div>

      {/* Procesado por estado con desglose por tipo */}
      {scopeBatches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {STATUS_ORDER.filter(s => totProc[s] > 0).map((s, idx) => {
            const cfg = STATUS_CFG[s]
            const detail = totProcDetail[s]
            return (
              <div key={s} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text2)', minWidth: 80, flexShrink: 0 }}>
                  {idx === 0 ? 'Procesado:' : ''}
                </span>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}`,
                }}>
                  {cfg.icon} {cfg.label}: {totProc[s]}
                </span>
                {ITEM_ORDER.filter(it => (detail[it] ?? 0) > 0).map(it => (
                  <span key={it} style={{ fontSize: 12, color: 'var(--text2)' }}>
                    {ITEM_CFG[it].icon} {detail[it]}
                  </span>
                ))}
              </div>
            )
          })}
          {totalRecv > 0 && totalListas > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text2)', minWidth: 80, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: totalListas >= totalRecv ? 'var(--green)' : 'var(--yellow,#d97706)', fontWeight: 600 }}>
                {totalListas >= totalRecv ? '✓ Todo listo' : `${totalRecv - totalListas} sin confirmar listas`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Discrepancias recibido vs. procesado declarado */}
      {scopeBatches.length > 0 && hasDisc && (
        <div style={{
          marginBottom: 8, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.35)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--yellow,#d97706)', marginBottom: 6 }}>
            Discrepancias recibido / procesado
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {ITEM_ORDER.map(it => {
              const d = discByItem[it]
              if (d === 0) return null
              const pos = d > 0  // positivo: recibido > procesado (falta declarar)
              return (
                <span key={it} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  background: pos ? 'rgba(245,158,11,.15)' : 'rgba(239,68,68,.12)',
                  color: pos ? 'var(--yellow,#d97706)' : 'var(--red,#ef4444)',
                  border: `1px solid ${pos ? 'rgba(245,158,11,.5)' : 'rgba(239,68,68,.4)'}`,
                }}>
                  {ITEM_CFG[it].icon} {pos ? `+${d} sin declarar` : `${d} de más declarados`}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Confirmaciones */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text2)', minWidth: 80, flexShrink: 0 }}>Recepciones:</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)' }}>
            ✓ {scope.filter(d => d.recipientStatus === 'ok').length} OK
          </span>
          {discResolved.length > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--yellow,#d97706)' }}>
              ⚠ {discResolved.length} disc. resuelta{discResolved.length > 1 ? 's' : ''}
            </span>
          )}
          {pending.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>
              {pending.length} pendiente{pending.length > 1 ? 's' : ''} de confirmar
            </span>
          )}
        </div>

        {/* Discrepancias pendientes de reconocer — destacadas */}
        {discPendingAck.length > 0 && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(239,68,68,.08)', border: '2px solid rgba(239,68,68,.35)',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red,#ef4444)' }}>
              ⚠ {discPendingAck.length} discrepancia{discPendingAck.length > 1 ? 's' : ''} pendiente{discPendingAck.length > 1 ? 's' : ''} de reconocer por el entregador
            </div>
            {discPendingAck.map(d => (
              <div key={d.id} style={{ fontSize: 12, color: 'var(--text2)', paddingLeft: 8 }}>
                · <strong>{d.deliveredByName}</strong> → {d.deliveredToName}
                {d.recipientNote && <span style={{ color: 'var(--text3)' }}> — "{d.recipientNote}"</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Listado compacto de batches ───────────────────────────────────────────────
function ProcessBatchList({ batches, showPerson }: { batches: ProcessBatch[]; showPerson?: boolean }) {
  if (batches.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {batches.map((b, i) => {
        const byStatus: Record<string, ProcessItem[]> = {}
        for (const item of b.items) {
          ;(byStatus[item.status] ??= []).push(item)
        }
        return (
          <div key={b.id} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, fontSize: 12, color: 'var(--text2)', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: 'var(--text1)' }}>
                {showPerson ? b.processedByName : `Lote ${i + 1}`}
              </span>
              <span>{fmtTime(b.processedAt)}</span>
              <span>📍 {b.distributionLocation}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {STATUS_ORDER.filter(s => (byStatus[s]?.length ?? 0) > 0).map(s => {
                const cfg   = STATUS_CFG[s]
                const items = byStatus[s]!
                return (
                  <span key={s} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '2px 9px', borderRadius: 8, fontSize: 12,
                    background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}`,
                  }}>
                    <strong style={{ fontWeight: 700 }}>{cfg.icon} {cfg.label}:</strong>
                    {items.map((item, j) => (
                      <span key={item.itemType}>
                        {j > 0 && <span style={{ color: cfg.color, opacity: .5 }}>·</span>}
                        <strong>{item.count}</strong>{' '}{ITEM_CFG[item.itemType as ItemTypeKey]?.icon ?? ''}
                      </span>
                    ))}
                    <strong>({items.reduce((s,i) => s+i.count,0)})</strong>
                  </span>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Cuadrícula de procesado ───────────────────────────────────────────────────
function ProcessItemGrid({ grid, onChange }: {
  grid: ProcessGrid
  onChange(status: StatusKey, itemType: ItemTypeKey, value: number): void
}) {
  const cell: React.CSSProperties = {
    width: '100%', textAlign: 'center', padding: '7px 4px', fontSize: 15, fontWeight: 700,
    borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)',
    boxSizing: 'border-box',
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 300 }}>
        <thead>
          <tr>
            <th style={{ width: 88, paddingBottom: 5, fontSize: 11, color: 'var(--text3)', fontWeight: 600, textAlign: 'left' }}></th>
            {ITEM_ORDER.map(it => (
              <th key={it} style={{ paddingBottom: 5, fontSize: 11, color: 'var(--text2)', fontWeight: 600, textAlign: 'center' }}>
                {ITEM_CFG[it].icon} {ITEM_CFG[it].label}
              </th>
            ))}
            <th style={{ paddingBottom: 5, fontSize: 11, color: 'var(--text3)', fontWeight: 600, textAlign: 'center', width: 38 }}>Σ</th>
          </tr>
        </thead>
        <tbody>
          {STATUS_ORDER.map(status => {
            const cfg      = STATUS_CFG[status]
            const rowTotal = ITEM_ORDER.reduce((s, it) => s + grid[status][it], 0)
            return (
              <tr key={status}>
                <td style={{ paddingRight: 6, paddingBottom: 5 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 7px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                    background: rowTotal > 0 ? cfg.bg : 'var(--bg2)',
                    color:      rowTotal > 0 ? cfg.color : 'var(--text3)',
                    border:     `1px solid ${rowTotal > 0 ? cfg.color : 'var(--border)'}`,
                    whiteSpace: 'nowrap',
                  }}>
                    {cfg.icon} {cfg.label}
                  </span>
                </td>
                {ITEM_ORDER.map(it => (
                  <td key={it} style={{ paddingBottom: 5, paddingLeft: 3, paddingRight: 3 }}>
                    <input type="number" min={0} value={grid[status][it]}
                      onChange={e => onChange(status, it, Math.max(0, Number(e.target.value)))}
                      style={{
                        ...cell,
                        background:  grid[status][it] > 0 ? cfg.bg : 'var(--bg2)',
                        borderColor: grid[status][it] > 0 ? cfg.color : 'var(--border)',
                        color:       grid[status][it] > 0 ? cfg.color : 'var(--text3)',
                      }}
                    />
                  </td>
                ))}
                <td style={{ paddingBottom: 5, textAlign: 'center', fontSize: 12, fontWeight: 700, color: rowTotal > 0 ? cfg.color : 'var(--text3)' }}>
                  {rowTotal || '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Vista principal ───────────────────────────────────────────────────────────
export default function LaundryView() {
  const { user }     = useAuth()
  const isLimpieza   = hasRole(user, 'limpieza')
  const isAdminUser  = canManage(user)
  const myId         = user?.id

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
  const [date,       setDate]       = useState(today)
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [batches,    setBatches]    = useState<ProcessBatch[]>([])
  const [staff,      setStaff]      = useState<StaffUser[]>([])
  const [suggest,    setSuggest]    = useState<Suggest | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [toastMsg,   setToastMsg]   = useState<string | null>(null)

  // ── Nueva entrega ─────────────────────────────────────────────────────────
  const [formOpen,      setFormOpen]      = useState(false)
  const [shower,        setShower]        = useState(0)
  const [hand,          setHand]          = useState(0)
  const [sheets,        setSheets]        = useState(0)
  const [foot,          setFoot]          = useState(0)
  const [location,      setLocation]      = useState('')
  const [deliveredToId, setDeliveredToId] = useState<number | ''>('')
  const [notes,         setNotes]         = useState('')
  const [saving,        setSaving]        = useState(false)

  // ── Procesado ─────────────────────────────────────────────────────────────
  const [processLocation, setProcessLocation] = useState('')
  const [processGrid,     setProcessGrid]     = useState<ProcessGrid>(emptyGrid())
  const [processSaving,   setProcessSaving]   = useState(false)

  function ok(msg: string) { setToastMsg(msg); setTimeout(() => setToastMsg(null), 3000) }

  async function apiFetch(path: string, opts?: RequestInit) {
    const r    = await fetch(path, { credentials: 'include', ...opts })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(typeof body.error === 'string' ? body.error : (body.message ?? `Error ${r.status}`))
    return body
  }

  const loadStaff = useCallback(async () => {
    try { setStaff((await apiFetch('/api/laundry/staff')).data ?? []) } catch { /* silencioso */ }
  }, [])

  const loadSuggest = useCallback(async () => {
    if (!date) return
    try { setSuggest((await apiFetch(`/api/laundry/suggest?date=${date}`)).data) }
    catch { setSuggest(null) }
  }, [date])

  const load = useCallback(async () => {
    if (!date) return
    setLoading(true)
    try {
      const response = await apiFetch(`/api/laundry?date=${date}`)
      setDeliveries(response.data ?? [])
      setBatches(response.batches ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [date])

  useEffect(() => { loadStaff() }, [])
  useEffect(() => { load(); if (isLimpieza) loadSuggest() }, [date])

  useEffect(() => {
    const id = setInterval(() => {
      load()
      if (isLimpieza) loadSuggest()
    }, 60_000)
    return () => clearInterval(id)
  }, [load, loadSuggest, isLimpieza])

  const visibleDeliveries = useMemo(() =>
    isAdminUser ? deliveries : deliveries.filter(d => d.deliveredById === myId || d.deliveredToId === myId),
    [deliveries, isAdminUser, myId],
  )

  const displayBatches = useMemo(() =>
    isAdminUser ? batches : batches.filter(b => b.processedById === myId),
    [batches, isAdminUser, myId],
  )

  const processDeclaredTotal = gridTotal(processGrid)

  function openForm() {
    setFormOpen(true)
    // Solo aplica sugerencia si hay valores reales pendientes
    if (suggest && (suggest.showerTowels > 0 || suggest.handTowels > 0 || suggest.sheetSets > 0 || suggest.footTowels > 0)) {
      setShower(suggest.showerTowels); setHand(suggest.handTowels)
      setSheets(suggest.sheetSets);    setFoot(suggest.footTowels)
    }
  }

  function setProcessCell(status: StatusKey, itemType: ItemTypeKey, value: number) {
    setProcessGrid(prev => ({ ...prev, [status]: { ...prev[status], [itemType]: value } }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!location.trim() || deliveredToId === '') return
    setSaving(true); setError(null)
    try {
      await apiFetch('/api/laundry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, location, deliveredToId: Number(deliveredToId), showerTowels: shower, handTowels: hand, sheetSets: sheets, footTowels: foot, notes: notes || null }),
      })
      ok('Entrega registrada')
      setFormOpen(false)
      setShower(0); setHand(0); setSheets(0); setFoot(0)
      setLocation(''); setDeliveredToId(''); setNotes('')
      await load()
      if (isLimpieza) loadSuggest()  // refresca la sugerencia tras cada entrega
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function handleDelete(id: number) {
    if (!confirm('¿Eliminar esta entrega?')) return
    try {
      await apiFetch(`/api/laundry/${id}`, { method: 'DELETE' })
      ok('Eliminado')
      setDeliveries(prev => prev.filter(d => d.id !== id))
    } catch (e: any) { setError(e.message) }
  }

  async function handleAddProcess() {
    const items = gridToItems(processGrid)
    if (items.length === 0) { setError('Indica al menos un artículo en la cuadrícula'); return }
    if (!processLocation.trim()) { setError('Indica el lugar donde quedan'); return }
    setProcessSaving(true); setError(null)
    try {
      await apiFetch('/api/laundry/process-batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, distributionLocation: processLocation, items }),
      })
      ok('Procesado declarado')
      setProcessGrid(emptyGrid())
      setProcessLocation('')
      load()
    } catch (e: any) { setError(e.message) }
    finally { setProcessSaving(false) }
  }

  const inp: React.CSSProperties = { padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 14, width: '100%', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)', marginBottom: 5 }
  const sec: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text3)', margin: '0 0 10px' }

  const hasBatches = displayBatches.length > 0
  const hasSuggest = suggest && (suggest.showerTowels > 0 || suggest.handTowels > 0 || suggest.sheetSets > 0 || suggest.footTowels > 0)

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '16px 12px 60px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Lavandería</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          {date !== today && <button className="btn btn-ghost btn-xs" onClick={() => setDate(today)}>Hoy</button>}
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ ...inp, width: 'auto', fontSize: 13, padding: '6px 10px' }} />
        </div>
      </div>

      {error && (
        <div className="alert-error" style={{ marginBottom: 12, borderRadius: 8 }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
        </div>
      )}

      {toastMsg && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: 'var(--green)', color: '#fff', padding: '10px 20px', borderRadius: 10, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,.3)', whiteSpace: 'nowrap' }}>
          {toastMsg}
        </div>
      )}

      {/* ── Resumen del día ───────────────────────────────────────────────── */}
      <DaySummary
        deliveries={deliveries}
        batches={batches}
        myId={myId}
        isAdminUser={isAdminUser}
      />

      {/* ── Entregas del día ──────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 14, padding: '12px 14px' }}>
        <p style={{ ...sec }}>
          Entregas del día
          {visibleDeliveries.length > 0 && (
            <span style={{ marginLeft: 6, background: 'var(--bg2)', color: 'var(--text2)', borderRadius: 10, padding: '1px 7px', fontWeight: 700, border: '1px solid var(--border)' }}>
              {visibleDeliveries.length}
            </span>
          )}
        </p>

        {visibleDeliveries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {visibleDeliveries.map(d => (
              <DeliveryRow
                key={d.id}
                d={d}
                myId={myId}
                isAdminUser={isAdminUser}
                staff={staff}
                onRefresh={load}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {!formOpen ? (
          <button className="btn btn-primary" style={{ width: '100%', padding: '9px', fontSize: 14 }}
            onClick={openForm}>
            + Registrar entrega
          </button>
        ) : (
          <form onSubmit={handleSubmit} style={{ paddingTop: visibleDeliveries.length > 0 ? 10 : 0, borderTop: visibleDeliveries.length > 0 ? '1px solid var(--border)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Nueva entrega</span>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setFormOpen(false)}>Cancelar</button>
            </div>

            {hasSuggest && suggest && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(99,102,241,.08)', border: '1px solid rgba(99,102,241,.2)', borderRadius: 8, marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                  Sugerido ({suggest.rooms} hab.):&nbsp;
                  🚿 {suggest.showerTowels} · 🖐 {suggest.handTowels} · 🛏 {suggest.sheetSets} · 👣 {suggest.footTowels}
                </div>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => {
                  setShower(suggest.showerTowels); setHand(suggest.handTowels)
                  setSheets(suggest.sheetSets);    setFoot(suggest.footTowels)
                }}>Aplicar</button>
              </div>
            )}

            {/* Cantidades en grid 2×2 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginBottom: 12 }}>
              {([['🚿','Ducha',shower,setShower],['🖐','Manos',hand,setHand],['🛏','Sábanas',sheets,setSheets],['👣','Pies',foot,setFoot]] as const).map(([icon,lbl,val,set]) => (
                <div key={lbl}>
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4, textAlign: 'center' }}>{icon} {lbl}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button type="button" onClick={() => (set as any)(Math.max(0, (val as number) - 1))}
                      style={{ width: 36, height: 38, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg2)', cursor: 'pointer', fontSize: 18, color: 'var(--text1)' }}>−</button>
                    <input type="number" min={0} value={val}
                      onChange={e => (set as any)(Math.max(0, Number(e.target.value)))}
                      style={{ flex: 1, minWidth: 0, textAlign: 'center', padding: '6px 4px', fontSize: 18, fontWeight: 700, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)' }} />
                    <button type="button" onClick={() => (set as any)((val as number) + 1)}
                      style={{ width: 36, height: 38, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg2)', cursor: 'pointer', fontSize: 18, color: 'var(--text1)' }}>+</button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={lbl}>Lugar de entrega</label>
                <input style={inp} placeholder="Ej: Armario pasillo 2ª" value={location} onChange={e => setLocation(e.target.value)} required />
              </div>
              <div>
                <label style={lbl}>Entregado a</label>
                <select style={{ ...inp, cursor: 'pointer' }} value={deliveredToId} onChange={e => setDeliveredToId(Number(e.target.value))} required>
                  <option value="">— Seleccionar —</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Notas <span style={{ fontWeight: 400, textTransform: 'none', fontSize: 12 }}>(opcional)</span></label>
              <input style={inp} placeholder="Observaciones…" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: 11, fontSize: 15 }}
              disabled={saving || !location.trim() || deliveredToId === ''}>
              {saving ? 'Guardando…' : 'Registrar entrega'}
            </button>
          </form>
        )}
      </div>

      {/* ── Procesado del día ─────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 14, padding: '12px 14px' }}>
        <p style={{ ...sec, marginBottom: hasBatches ? 10 : 0 }}>
          {isAdminUser ? 'Procesado declarado' : 'Mi procesado'}
          {hasBatches && (
            <span style={{ marginLeft: 6, background: 'var(--green)', color: '#fff', borderRadius: 10, padding: '1px 7px', fontWeight: 700 }}>
              {displayBatches.length}
            </span>
          )}
        </p>

        {hasBatches && (
          <div style={{ marginBottom: 14 }}>
            <ProcessBatchList batches={displayBatches} showPerson={isAdminUser} />
          </div>
        )}

        <div style={{ paddingTop: hasBatches ? 12 : 0, borderTop: hasBatches ? '1px solid var(--border)' : 'none' }}>
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Lugar donde quedan</label>
            <input style={inp} placeholder="Ej: Armario 1ª planta"
              value={processLocation} onChange={e => setProcessLocation(e.target.value)} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Estado por tipo de prenda</label>
            <ProcessItemGrid grid={processGrid} onChange={setProcessCell} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', padding: 10, fontSize: 14 }}
            disabled={processSaving || !processLocation.trim() || processDeclaredTotal === 0}
            onClick={handleAddProcess}>
            {processSaving ? 'Guardando…' : hasBatches ? '+ Añadir procesado' : '+ Declarar procesado'}
          </button>
        </div>
      </div>

      {!loading && deliveries.length === 0 && batches.length === 0 && !formOpen && (
        <div style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--text2)', background: 'var(--bg2)', borderRadius: 12, border: '1px dashed var(--border)' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>👕</div>
          <div style={{ fontSize: 14 }}>Sin actividad registrada para este día.</div>
        </div>
      )}
    </div>
  )
}
