import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { api, type Rate } from '../lib/api'
import { today, addDays, getDays, toast, rootRateOf } from '../lib/utils'
import { useAuth, hasRole, canManage } from '../contexts/AuthContext'
import { RoomChangeReasonField, roomChangeNeedsReason, countReasonWords, MIN_REASON_WORDS } from '../components/RoomChangeReasonField'
import { Modal } from '../components/Modal'
import { ReservationDrawer } from './ReservationDetailView'

const LABEL_W_DESK   = 120
const LABEL_W_MOB    = 60
const SIDEBAR_W_DESK = 220


function computeCellW(numDays: number, mobile: boolean) {
  const lw = mobile ? LABEL_W_MOB : LABEL_W_DESK
  const sw = mobile ? 0 : SIDEBAR_W_DESK
  const avail = window.innerWidth - sw - lw - 16
  return Math.min(140, Math.max(mobile ? 72 : 64, Math.floor(avail / numDays)))
}

const STATUS_COLOR: Record<string, string> = {
  confirmed:    '#4f7cff',
  tentative:    '#9ca3af',
  arriving:     '#f59e0b',
  checked_in:   '#22c55e',
  checking_out: '#fb923c',
  checked_out:  '#6b7280',
  cancelled:    '#ef4444',
  no_show:      '#a855f7',
}

const STATUS_LABEL: Record<string, string> = {
  confirmed:    'Confirmada',
  tentative:    'Provisional',
  arriving:     'Por llegar',
  checked_in:   'En casa',
  checking_out: 'Saliendo',
  checked_out:  'Ha salido',
  cancelled:    'Cancelada',
  no_show:      'No show',
}

function autoFitDays(mobile: boolean) {
  const lw = mobile ? LABEL_W_MOB : LABEL_W_DESK
  const sw = mobile ? 0 : SIDEBAR_W_DESK
  const avail = window.innerWidth - sw - lw - 16
  if (mobile) return Math.min(4, Math.max(3, Math.floor(avail / 80)))
  return Math.min(12, Math.max(5, Math.floor(avail / 36)))
}

export default function PlanningView() {
  const { user } = useAuth()
  const canFdm = user?.isPrimary || hasRole(user, 'recepcion', 'direccion')
  const isDireccion = !!(user?.isPrimary || hasRole(user, 'direccion'))

  const navigate  = useNavigate()
  const [isMobile,  setIsMobile] = useState(() => window.innerWidth < 640)
  const [from,     setFrom]    = useState(addDays(today(), -1))
  const [numDays,  setNumDays] = useState(() => autoFitDays(window.innerWidth < 640))
  const [rooms,    setRooms]   = useState<any[]>([])
  const [reservations, setReservations] = useState<any[]>([])
  const [rates,    setRates]   = useState<Rate[]>([])
  const [loading,  setLoading] = useState(true)
  const [error,    setError]   = useState<string | null>(null)
  const [newResModal,  setNewResModal]  = useState<{ roomId: number; roomCode: string; date: string; checkOut?: string } | null>(null)
  const [ctxMenu,      setCtxMenu]      = useState<{ x: number; y: number; roomId: number; roomCode: string; roomTypeId: number; date: string; bedNumber: string } | null>(null)
  const [blockModal,   setBlockModal]   = useState<{ roomId: number; roomCode: string; roomTypeId: number; date: string; dateEnd?: string; bedNumber: string } | null>(null)
  const [dragCreate,   setDragCreate]   = useState<{ roomId: number; roomTypeId: number; bedNumber: string; startDate: string; endDate: string } | null>(null)
  const [rangeMenu,    setRangeMenu]    = useState<{ x: number; y: number; roomId: number; roomCode: string; roomTypeId: number; bedNumber: string; checkIn: string; checkOut: string } | null>(null)
  const [blockedBeds,  setBlockedBeds]  = useState<any[]>([])
  const [dragging,     setDragging]     = useState<{ res: any; grabOffset: number } | null>(null)
  const [dragTarget,   setDragTarget]   = useState<{ roomId: number; date: string } | null>(null)
  const [moveModal,    setMoveModal]    = useState<{
    res: any; newRoomId: number; newRoom: any
    newCheckIn: string; newCheckOut: string; newNights: number
  } | null>(null)
  const [resCtxMenu,    setResCtxMenu]    = useState<{ x: number; y: number; res: any } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ res: any } | null>(null)
  const [drawerResId,   setDrawerResId]   = useState<number | null>(null)
  const [moveRoomModal, setMoveRoomModal] = useState<{ res: any } | null>(null)
  const [gotoOpen,      setGotoOpen]      = useState(false)
  const [highlightResId, setHighlightResId] = useState<number | null>(null)
  const [occupancy, setOccupancy] = useState<{ today: { pct: number; occupied: number; total: number }; week: { pct: number; from: string; to: string } } | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const patchResInState = (id: number, patch: Record<string, any>) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  const flashHighlight = (id: number) => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    setHighlightResId(id)
    highlightTimer.current = setTimeout(() => setHighlightResId(null), 2500)
  }

  const to = addDays(from, numDays - 1)

  const load = useCallback(async (f: string, nd: number, silent = false) => {
    const t = addDays(f, nd - 1)
    if (!silent) { setLoading(true); setError(null) }
    try {
      const [r, res, rt]: any[] = await Promise.all([
        api.listRooms(),
        api.planningReservations({ dateFrom: f, dateTo: t }),
        api.listRates(),
      ])
      const sorted = r.data.slice().sort((a: any, b: any) => {
        const na = parseInt(a.code), nb = parseInt(b.code)
        if (!isNaN(na) && !isNaN(nb)) return na - nb
        if (!isNaN(na)) return -1
        if (!isNaN(nb)) return 1
        return a.code.localeCompare(b.code)
      })
      const bb: any = await api.listBlockedBeds().catch(() => ({ data: [] }))
      setRooms(sorted); setReservations(res.data); setRates(rt.data); setBlockedBeds(bb.data)
    } catch (e: any) { if (!silent) setError(e.message) }
    finally { if (!silent) setLoading(false) }
  }, [])

  useEffect(() => {
    load(from, numDays)
    api.dashboardOccupancy().then(r => setOccupancy(r.data)).catch(() => {})
  }, []) // eslint-disable-line

  useEffect(() => {
    const cancel = () => setDragCreate(null)
    window.addEventListener('mouseup', cancel)
    return () => window.removeEventListener('mouseup', cancel)
  }, [])

  // Refresco silencioso: solo actualiza reservas sin tocar rooms/rates ni mover el scroll
  const fromRef       = useRef(from)
  const numDaysRef    = useRef(numDays)
  const ganttBodyRef  = useRef<HTMLDivElement>(null)
  const savedScrollRef = useRef<number>(0)
  useEffect(() => { fromRef.current = from },       [from])
  useEffect(() => { numDaysRef.current = numDays }, [numDays])

  // Restaurar scroll antes del paint para evitar flash
  useLayoutEffect(() => {
    if (savedScrollRef.current > 0 && ganttBodyRef.current) {
      ganttBodyRef.current.scrollLeft = savedScrollRef.current
      savedScrollRef.current = 0
    }
  }, [reservations])

  const reloadBlocks = useCallback(async () => {
    const bb = await api.listBlockedBeds().catch(() => ({ data: [] }))
    setBlockedBeds(bb.data)
  }, [])

  const reloadReservations = useCallback(async () => {
    const f  = fromRef.current
    const nd = numDaysRef.current
    const t  = addDays(f, nd - 1)
    savedScrollRef.current = ganttBodyRef.current?.scrollLeft ?? 0
    try {
      const res = await api.planningReservations({ dateFrom: f, dateTo: t })
      console.log('[Planning] reloadReservations OK — reservas:', res.data.length,
        '— primer huésped:', res.data[0]?.guest?.firstName, res.data[0]?.guest?.lastName,
        '— guestCount[0]:', res.data[0]?.guestCount)
      setReservations(res.data)
    } catch (err) {
      console.error('[Planning] reloadReservations ERROR', err)
    }
  }, [])

  useEffect(() => {
    window.addEventListener('reservation:changed', reloadReservations)
    return () => window.removeEventListener('reservation:changed', reloadReservations)
  }, [reloadReservations])

  const shift = (n: number) => {
    const nf = addDays(from, n)
    setFrom(nf); load(nf, numDays)
  }

  const apply = () => { load(from, numDays) }

  const goToday = () => {
    const mob = isMobile
    const nd = autoFitDays(mob)
    const f = addDays(today(), -1)
    setNumDays(nd); setFrom(f); load(f, nd)
  }

  const goPreset = (preset: string) => {
    const mob = isMobile
    const nd = autoFitDays(mob)
    let f: string
    if (preset === 'today')     f = addDays(today(), -1)
    else if (preset === 'ayer') f = addDays(today(), -2)
    else if (preset === 'mes')  f = addDays(today(), -31)
    else                        f = addDays(today(), -366)
    setNumDays(nd); setFrom(f); load(f, nd)
  }

  // Recompute cell width on window resize
  useEffect(() => {
    const onResize = () => {
      const mob = window.innerWidth < 640
      setIsMobile(mob)
      setNumDays(autoFitDays(mob))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const days   = getDays(from, to)
  const todayS = today()
  const cellW  = computeCellW(numDays, isMobile)
  const totalW = days.length * cellW
  const labelW = isMobile ? LABEL_W_MOB : LABEL_W_DESK

  const realRooms   = rooms.filter(r => r.code !== 'VIRTUAL')
  const totalSlots  = realRooms.length * days.length
  const activeRes   = reservations.filter(r => !['cancelled', 'no_show'].includes(r.status))
  let occupiedSlots = 0
  for (const res of activeRes) {
    const start = res.checkInDate  < from ? from : res.checkInDate
    const end   = res.checkOutDate > to   ? to   : res.checkOutDate
    const si    = days.indexOf(start)
    const ei    = days.indexOf(end)
    const s     = si >= 0 ? si : 0
    const e     = ei >= 0 ? ei : days.length
    if (e > s) occupiedSlots += (e - s)
  }
  const occPct = totalSlots > 0 ? Math.round(occupiedSlots / totalSlots * 100) : 0

  let occBg, occColor, occMsg
  if (occPct >= 80) {
    occBg = 'rgba(34,197,94,0.12)'; occColor = '#22c55e'
    occMsg = 'Alta demanda — considera subir precios'
  } else if (occPct >= 50) {
    occBg = 'rgba(79,124,255,0.1)'; occColor = '#6b93ff'
    occMsg = 'Ocupación media'
  } else {
    occBg = 'rgba(245,158,11,0.12)'; occColor = '#f59e0b'
    occMsg = 'Baja ocupación — considera bajar precios o promocionar'
  }

  const rateRoot = rootRateOf(rates as any[]) as Rate | undefined

  const saveRate = async (rateId: number, value: number) => {
    try { await api.updateRate(rateId, { adjustValue: value }); toast('Precio guardado') }
    catch (e: any) { toast(e.message, 'err') }
  }

  // Drag-to-create helpers
  const handleCellsMouseMove = (e: React.MouseEvent, roomId: number, bedNumber: string) => {
    if (!dragCreate || dragCreate.roomId !== roomId || dragCreate.bedNumber !== bedNumber) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dayIdx = Math.floor((e.clientX - rect.left) / cellW)
    if (dayIdx >= 0 && dayIdx < days.length) {
      const hoverDate = days[dayIdx]!
      if (hoverDate !== dragCreate.endDate) setDragCreate(prev => prev ? { ...prev, endDate: hoverDate } : null)
    }
  }

  const handleCellsMouseUp = (e: React.MouseEvent, roomId: number, roomCode: string, roomTypeId: number, bedNumber: string) => {
    if (!dragCreate || dragCreate.roomId !== roomId || dragCreate.bedNumber !== bedNumber || e.button !== 0) return
    const { startDate, endDate } = dragCreate
    setDragCreate(null)
    const checkIn      = startDate <= endDate ? startDate : endDate
    const checkOutBase = startDate <= endDate ? endDate   : startDate
    if (checkIn === checkOutBase) {
      setNewResModal({ roomId, roomCode, date: checkIn })
    } else {
      setRangeMenu({ x: e.clientX, y: e.clientY, roomId, roomCode, roomTypeId, bedNumber, checkIn, checkOut: addDays(checkOutBase, 1) })
    }
    e.stopPropagation()
  }

  // Drag-and-drop handlers
  const handleCellsDragOver = (e: React.DragEvent, roomId: number) => {
    if (!dragging) return
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dayIdx = Math.floor((e.clientX - rect.left) / cellW)
    if (dayIdx >= 0 && dayIdx < days.length) {
      setDragTarget({ roomId, date: days[dayIdx]! })
    }
  }

  const handleCellsDrop = (e: React.DragEvent, roomId: number) => {
    e.preventDefault()
    if (!dragging) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dayIdx = Math.floor((e.clientX - rect.left) / cellW)
    if (dayIdx < 0 || dayIdx >= days.length) { setDragging(null); setDragTarget(null); return }
    const dropDate = days[dayIdx]!
    const duration = Math.round(
      (new Date(dragging.res.checkOutDate).getTime() - new Date(dragging.res.checkInDate).getTime()) / 86400000
    )
    const newCheckIn  = addDays(dropDate, -dragging.grabOffset)
    const newCheckOut = addDays(newCheckIn, duration)

    const hasBlock = blockedBeds.some(b => b.roomId === roomId && b.blockDate >= newCheckIn && b.blockDate < newCheckOut)
    if (hasBlock) {
      toast('No se puede mover: hay días bloqueados en esa habitación para ese período', 'err')
      setDragging(null); setDragTarget(null)
      return
    }

    const newRoom = rooms.find((r: any) => r.id === roomId)
    setMoveModal({ res: dragging.res, newRoomId: roomId, newRoom, newCheckIn, newCheckOut, newNights: duration })
    setDragging(null); setDragTarget(null)
  }

  // Drop-zone highlight bounds
  let dropZoneRoomId: number | null = null
  let dropZoneStart: string  | null = null
  let dropZoneEnd:   string  | null = null
  if (dragging && dragTarget) {
    const dur = Math.round(
      (new Date(dragging.res.checkOutDate).getTime() - new Date(dragging.res.checkInDate).getTime()) / 86400000
    )
    dropZoneRoomId = dragTarget.roomId
    dropZoneStart  = addDays(dragTarget.date, -dragging.grabOffset)
    dropZoneEnd    = addDays(dropZoneStart, dur)
  }

  // ¿El drop zone tiene alguna cama bloqueada en ese rango?
  const isDropZoneConflicted = dropZoneRoomId != null && dropZoneStart != null && dropZoneEnd != null &&
    blockedBeds.some(b => b.roomId === dropZoneRoomId && b.blockDate >= dropZoneStart! && b.blockDate < dropZoneEnd!)

  // Color por tipo de habitación — usa backgroundColor del tipo si está definido, si no paleta
  const TYPE_PALETTE = ['#4f7cff','#22c55e','#f59e0b','#a855f7','#ec4899','#06b6d4','#f97316','#84cc16']
  const typeColorMap: Record<number, string> = {}
  ;[...new Set(rooms.map((r: any) => r.roomTypeId).filter(Boolean))].forEach((tid, i) => {
    const rt = rooms.find((r: any) => r.roomTypeId === tid)?.roomType
    typeColorMap[tid as number] = rt?.backgroundColor || TYPE_PALETTE[i % TYPE_PALETTE.length]
  })

  // blocked: key = `roomId-bedNumber-date`
  const blockedMap: Record<string, { id: number; reason?: string; locked?: boolean }> = {}
  for (const b of blockedBeds) {
    blockedMap[`${b.roomId}-${b.bedNumber}-${b.blockDate}`] = { id: b.id, reason: b.reason, locked: !!b.lockedByDirection }
  }

  const byRoom: Record<number, any[]> = {}
  for (const r of reservations) {
    if (r.roomId && !['cancelled', 'no_show'].includes(r.status)) {
      if (!byRoom[r.roomId]) byRoom[r.roomId] = []
      byRoom[r.roomId]!.push(r)
      for (const extraRoomId of (r.extraRoomIds ?? [])) {
        if (!byRoom[extraRoomId]) byRoom[extraRoomId] = []
        byRoom[extraRoomId]!.push({ ...r, _isExtraRoom: true })
      }
    }
  }

  // Asigna cada reserva a slots consecutivos, uno por huésped — PERO solo
  // entre los huéspedes que de verdad duermen EN ESTA habitación (roomId),
  // no todo res.additionalGuests (que trae TODOS los adicionales del grupo,
  // repartidos por varias habitaciones si es una reserva de grupo). Antes se
  // ignoraba esto y toda habitación del grupo mostraba titular+primeros
  // adicionales sin mirar dónde estaban asignados de verdad.
  // Devuelve arrays donde cada elemento lleva _slotGuest con el huésped de ese slot.
  function assignSlots(resList: any[], numSlots: number, roomId: number): any[][] {
    const slots: any[][] = Array.from({ length: Math.max(numSlots, 1) }, () => [])
    const sorted = [...resList].sort((a, b) => a.checkInDate.localeCompare(b.checkInDate))

    for (const res of sorted) {
      const isPrimaryRoom = res.roomId === roomId
      // roomId no viene (reserva de antes de poder asignar habitación por
      // huésped) → cae en la principal, igual que hacía siempre el backend.
      const additionalHere = (res.additionalGuests ?? []).filter((g: any) => (g.roomId ?? res.roomId) === roomId)
      const allGuests: any[] = isPrimaryRoom ? [res.guest, ...additionalHere] : additionalHere
      const need = Math.min(Math.max(allGuests.length, 1), slots.length)
      let placed = false
      outer: for (let start = 0; start <= slots.length - need; start++) {
        for (let j = 0; j < need; j++) {
          if (slots[start + j]!.some((r: any) =>
            r.checkInDate < res.checkOutDate && r.checkOutDate > res.checkInDate
          )) continue outer
        }
        for (let j = 0; j < need; j++) {
          // Sin nadie asignado todavía a esta extra (allGuests vacío): cae en
          // el titular como aviso de que falta asignar, en vez de dejarlo en blanco.
          slots[start + j]!.push({ ...res, _slotGuest: allGuests[j] ?? res.guest })
        }
        placed = true; break
      }
      if (!placed) slots[slots.length - 1]!.push({ ...res, _slotGuest: allGuests[0] ?? res.guest })
    }
    return slots
  }

  return (
    <div className="planning-page">
      <div className="planning-toolbar">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => shift(-1)} title="Día anterior">‹</button>
          <span className="plan-current-date">
            {new Date(from + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: isMobile ? undefined : 'numeric' })}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => shift(+1)} title="Día siguiente">›</button>
          {!isMobile && (
            <div className="plan-goto-wrap" style={{ position: 'relative' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setGotoOpen(v => !v)}>Ir a ▾</button>
              {gotoOpen && (
                <GotoDropdown onSelect={preset => { setGotoOpen(false); goPreset(preset) }} onClose={() => setGotoOpen(false)} />
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!isMobile && <><span style={{ color: 'var(--text2)', fontSize: 12 }}>Desde</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="plan-date-input" /></>}
          <span style={{ color: 'var(--text2)', fontSize: 12 }}>Días</span>
          <input type="number" value={numDays}
            min={isMobile ? 3 : 5} max={isMobile ? 4 : 30}
            onChange={e => setNumDays(Number(e.target.value) || numDays)}
            onBlur={e => {
              const min = isMobile ? 3 : 5
              const max = isMobile ? 4 : 30
              setNumDays(Math.min(max, Math.max(min, Number(e.target.value) || min)))
            }}
            className="plan-date-input" style={{ width: 56 }} />
          <button className="btn btn-ghost btn-sm" onClick={apply}>Aplicar</button>
          {canFdm && <FdmSyncButton onDone={reloadReservations} />}
        </div>
      </div>

      {loading && <div className="loading">Cargando…</div>}
      {error   && <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>}

      {!loading && !error && rooms.length === 0 && <div className="empty"><p>Sin habitaciones</p></div>}

      {!loading && !error && rooms.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <OccCard label="Hoy"
              pct={occupancy?.today.pct ?? null}
              sub={occupancy ? `${occupancy.today.occupied} / ${occupancy.today.total} hab.` : '…'} />
            <OccCard label="Esta semana"
              pct={occupancy?.week.pct ?? null}
              sub={occupancy ? `${occupancy.week.from.slice(5)} → ${occupancy.week.to.slice(5)}` : '…'} />
            <OccCard label={`Selección (${days.length} días)`}
              pct={occPct}
              sub={occMsg}
              wide />
            <div className="occ-rates" style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {rateRoot && <OccRateInput label={`${rateRoot.title} / noche`} rate={rateRoot} onSave={saveRate} />}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              {rooms.length} habitaciones · haz clic en una celda para crear reserva
            </span>
          </div>

          <div className="gantt-scroll" ref={ganttBodyRef}>
            <div className="gantt-header">
              <div className="gantt-corner">Habitación</div>
              <div className="gantt-header-dates" style={{ width: totalW }}>
                {days.map(d => {
                  const dt = new Date(d + 'T12:00:00')
                  const dow = dt.toLocaleDateString('es-ES', { weekday: 'short' })
                  const isWeekend = dt.getDay() === 0 || dt.getDay() === 6
                  return (
                    <div key={d} className={`gantt-day-head${d === todayS ? ' today' : ''}${isWeekend ? ' weekend' : ''}`}
                      style={{ width: cellW, minWidth: cellW }}>
                      <span className="gantt-dow">{dow}</span>
                      <span className="gantt-daynum">{dt.getDate()}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="gantt-body">
              {rooms.map(room => {
                const maxOccupancy = room.roomType?.maxOccupancy ?? 1
                const resList      = byRoom[room.id] ?? []
                const slots        = assignSlots(resList, maxOccupancy, room.id)
                const typeColor    = (room as any).backgroundColor || typeColorMap[room.roomTypeId] || '#6b7280'

                return [
                  // ── Cabecera de habitación ──────────────────────────────
                  <div key={`${room.id}-hdr`} className="gantt-row gantt-row-room-header"
                    style={{ '--room-color': typeColor } as React.CSSProperties}>
                    <div className="gantt-label-col gantt-label-room-header">
                      <span className="gantt-room-code-hdr">{room.code}</span>
                      <span className="gantt-room-type-hdr">{room.roomType?.name ?? ''}</span>
                    </div>
                    <div className="gantt-cells-col gantt-header-cells" style={{ width: totalW }}
                      onDragOver={e => handleCellsDragOver(e, room.id)}
                      onDrop={e => handleCellsDrop(e, room.id)}
                    >
                      {days.map(d => {
                        const dt = new Date(d + 'T12:00:00')
                        const isWeekend = dt.getDay() === 0 || dt.getDay() === 6
                        const isDropZone = !isDropZoneConflicted && dropZoneRoomId === room.id && dropZoneStart != null && d >= dropZoneStart && d < dropZoneEnd!
                        return (
                          <div key={d} className={`gantt-cell gantt-cell-hdr${isWeekend ? ' weekend' : ''}${d === todayS ? ' today' : ''}${isDropZone ? ' gantt-cell-drop-zone' : ''}`}
                            style={{ width: cellW, minWidth: cellW }} />
                        )
                      })}
                    </div>
                  </div>,

                  // ── Filas de plazas ─────────────────────────────────────
                  ...slots.map((slotRes, slotIdx) => {
                  const isLast    = slotIdx === slots.length - 1
                  const bedNumber = String((room.startingBedNumber ?? 1) + slotIdx)

                  return (
                    <div key={`${room.id}-${slotIdx}`}
                      className={`gantt-row gantt-row-bed${isLast ? ' gantt-row-room-last' : ''}`}
                      style={{ '--room-color': typeColor } as React.CSSProperties}
                    >
                      <div className="gantt-label-col gantt-label-plaza">
                        <span className="gantt-bed-label">plaza {slotIdx + 1}</span>
                      </div>
                      <div className="gantt-cells-col" style={{ width: totalW }}
                        onDragOver={e => handleCellsDragOver(e, room.id)}
                        onDrop={e => handleCellsDrop(e, room.id)}
                        onMouseMove={e => handleCellsMouseMove(e, room.id, bedNumber)}
                        onMouseUp={e => handleCellsMouseUp(e, room.id, room.code, room.roomTypeId, bedNumber)}
                      >
                        {days.map(d => {
                          const dt        = new Date(d + 'T12:00:00')
                          const isWeekend = dt.getDay() === 0 || dt.getDay() === 6
                          const blockKey  = `${room.id}-${bedNumber}-${d}`
                          const blocked   = blockedMap[blockKey]
                          const isDropZone = !blocked && dropZoneRoomId === room.id && dropZoneStart != null && d >= dropZoneStart && d < dropZoneEnd!
                          const dc = dragCreate
                          const isCreating = !blocked && dc?.roomId === room.id && dc?.bedNumber === bedNumber &&
                            d >= (dc.startDate <= dc.endDate ? dc.startDate : dc.endDate) &&
                            d <= (dc.startDate <= dc.endDate ? dc.endDate   : dc.startDate)
                          return (
                            <div key={d}
                              className={`gantt-cell${isWeekend ? ' weekend' : ''}${d === todayS ? ' today' : ''}${blocked ? ' gantt-cell-blocked' : ''}${isDropZone ? ' gantt-cell-drop-zone' : ''}${isCreating ? ' gantt-cell-creating' : ''}`}
                              style={{ width: cellW, minWidth: cellW }}
                              title={blocked?.reason ? `Bloqueado: ${blocked.reason}` : blocked ? 'Bloqueado' : undefined}
                              onMouseDown={e => {
                                if (blocked || dragging || e.button !== 0) return
                                e.preventDefault()
                                setDragCreate({ roomId: room.id, roomTypeId: room.roomTypeId, bedNumber, startDate: d, endDate: d })
                                setRangeMenu(null)
                              }}
                              onContextMenu={e => {
                                if (dragging) return
                                e.preventDefault()
                                e.stopPropagation()
                                setCtxMenu({
                                  x: e.clientX, y: e.clientY,
                                  roomId: room.id, roomCode: room.code,
                                  roomTypeId: room.roomTypeId,
                                  date: d, bedNumber,
                                })
                              }}
                            />
                          )
                        })}
                        {slotRes.map((res: any) => {
                          const clipStart = res.checkInDate >= from ? res.checkInDate : from
                          const si = days.indexOf(clipStart)
                          if (si < 0) return null
                          let ei: number
                          if (res.checkOutDate > to) { ei = days.length }
                          else { ei = days.indexOf(res.checkOutDate); if (ei < 0 || ei <= si) return null }

                          const left  = si * cellW + 2
                          const width = (ei - si) * cellW - 4
                          const isLateNoShow = res.status === 'confirmed' && res.checkInDate < todayS
                          const displayStatus = isLateNoShow ? 'no_show' : res.status
                          const color = STATUS_COLOR[displayStatus] ?? '#8b90a8'
                          const slotGuest = res._slotGuest ?? res.guest
                          const guest = slotGuest ? `${slotGuest.firstName} ${slotGuest.lastName}` : '—'
                          const code   = res.externalCode ?? '#' + res.id
                          const label  = isLateNoShow ? 'Posible no-show' : (STATUS_LABEL[res.status] ?? res.status)

                          const isDraggingThis  = dragging?.res.id === res.id
                          const isHighlighted   = highlightResId === res.id
                          const hasDue          = res.status === 'checked_in' && (res.pendingAmount ?? 0) > 0.01
                          const isExtraRoom     = !!res._isExtraRoom
                          return (
                            <div key={isExtraRoom ? `extra-${res.id}` : res.id}
                              className={`gantt-bar${isLateNoShow ? ' gantt-bar-noshow' : ''}${isDraggingThis ? ' gantt-bar-dragging' : ''}${isHighlighted ? ' gantt-bar-highlight' : ''}${isExtraRoom ? ' gantt-bar-extra-room' : ''}`}
                              style={{ left, width, background: color + '99', borderLeft: `3px solid ${color}`, color: '#fff', ...(isExtraRoom ? { backgroundImage: 'repeating-linear-gradient(135deg,transparent,transparent 4px,rgba(0,0,0,.15) 4px,rgba(0,0,0,.15) 8px)' } : {}) }}
                              draggable={!isExtraRoom}
                              onDragStart={isExtraRoom ? undefined : e => {
                                e.stopPropagation()
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                const grabOffset = Math.max(0, Math.floor((e.clientX - rect.left) / cellW))
                                e.dataTransfer.effectAllowed = 'move'
                                e.dataTransfer.setData('text/plain', String(res.id))
                                setDragging({ res, grabOffset })
                              }}
                              onDragEnd={isExtraRoom ? undefined : () => { setDragging(null); setDragTarget(null) }}
                              onClick={e => {
                                e.stopPropagation()
                                if (!dragging) setDrawerResId(res.id)
                              }}
                              onContextMenu={e => {
                                e.preventDefault(); e.stopPropagation()
                                if (!isExtraRoom) setResCtxMenu({ x: e.clientX, y: e.clientY, res })
                              }}
                              title={`${guest} · ${code} · ${label} · ${res.checkInDate} → ${res.checkOutDate}${isExtraRoom ? ' · Hab. adicional' : ''}${hasDue ? ` · Pendiente: ${res.pendingAmount.toFixed(2)} €` : ''}`}
                            >
                              <span className="gantt-bar-name">{isExtraRoom ? '+ ' : ''}{guest}</span>
                              {hasDue && !isExtraRoom && (
                                <span className="gantt-bar-due" title={`Pendiente ${res.pendingAmount.toFixed(2)} €`}>€</span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                }),
                ]
              })}
            </div>
          </div>

          <div className="gantt-legend">
            {Object.entries(STATUS_COLOR).map(([s, c]) => (
              <span key={s} className="gantt-legend-item">
                <span className="gantt-legend-dot" style={{ background: c + '99', border: `2px solid ${c}` }} />
                {STATUS_LABEL[s]}
              </span>
            ))}
          </div>
        </>
      )}

      {newResModal && (
        <NewReservationModal
          roomId={newResModal.roomId}
          roomCode={newResModal.roomCode}
          date={newResModal.date}
          checkOut={newResModal.checkOut}
          rates={rates}
          rooms={rooms}
          onClose={() => setNewResModal(null)}
          onCreated={id => { setNewResModal(null); navigate(`/reservations/${id}`) }}
        />
      )}

      {ctxMenu && (
        <ContextMenuPopup
          x={ctxMenu.x} y={ctxMenu.y}
          isBlocked={!!blockedMap[`${ctxMenu.roomId}-${ctxMenu.bedNumber}-${ctxMenu.date}`]}
          blockId={blockedMap[`${ctxMenu.roomId}-${ctxMenu.bedNumber}-${ctxMenu.date}`]?.id}
          blockLocked={!!blockedMap[`${ctxMenu.roomId}-${ctxMenu.bedNumber}-${ctxMenu.date}`]?.locked && !isDireccion}
          onNewReservation={() => {
            setNewResModal({ roomId: ctxMenu.roomId, roomCode: ctxMenu.roomCode, date: ctxMenu.date })
            setCtxMenu(null)
          }}
          onBlock={() => {
            setBlockModal({ roomId: ctxMenu.roomId, roomCode: ctxMenu.roomCode, roomTypeId: ctxMenu.roomTypeId, date: ctxMenu.date, bedNumber: ctxMenu.bedNumber })
            setCtxMenu(null)
          }}
          onUnblock={async (id) => {
            try { await api.unblockBed(id); toast('Bloqueo eliminado'); reloadBlocks() }
            catch (e: any) { toast(e.message, 'err') }
            setCtxMenu(null)
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {rangeMenu && (
        <RangeMenu
          x={rangeMenu.x} y={rangeMenu.y}
          checkIn={rangeMenu.checkIn} checkOut={rangeMenu.checkOut}
          onNewRes={() => {
            setNewResModal({ roomId: rangeMenu.roomId, roomCode: rangeMenu.roomCode, date: rangeMenu.checkIn, checkOut: rangeMenu.checkOut })
            setRangeMenu(null)
          }}
          onBlock={() => {
            setBlockModal({ roomId: rangeMenu.roomId, roomCode: rangeMenu.roomCode, roomTypeId: rangeMenu.roomTypeId, bedNumber: rangeMenu.bedNumber, date: rangeMenu.checkIn, dateEnd: addDays(rangeMenu.checkOut, -1) })
            setRangeMenu(null)
          }}
          onClose={() => setRangeMenu(null)}
        />
      )}

      {blockModal && (
        <BlockModal
          roomCode={blockModal.roomCode}
          date={blockModal.date}
          dateEnd={blockModal.dateEnd}
          bedNumber={blockModal.bedNumber}
          onClose={() => setBlockModal(null)}
          canLock={isDireccion}
          onSaved={async (reason, locked) => {
            try {
              const dates: string[] = []
              let cur = blockModal.date
              const end = blockModal.dateEnd ?? blockModal.date
              while (cur <= end) { dates.push(cur); cur = addDays(cur, 1) }
              await Promise.all(dates.map(d =>
                api.blockBed({ roomId: blockModal.roomId, roomTypeId: blockModal.roomTypeId, bedNumber: blockModal.bedNumber, blockDate: d, reason: reason || undefined, lockedByDirection: locked || undefined })
              ))
              toast(dates.length > 1 ? `${dates.length} fechas bloqueadas` : 'Plaza bloqueada')
              setBlockModal(null)
              reloadBlocks()
            } catch (e: any) { toast(e.message, 'err') }
          }}
        />
      )}

      {moveModal && (
        <MoveConfirmModal
          res={moveModal.res}
          newRoom={moveModal.newRoom}
          newCheckIn={moveModal.newCheckIn}
          newCheckOut={moveModal.newCheckOut}
          newNights={moveModal.newNights}
          onClose={() => setMoveModal(null)}
          onConfirm={async (reason) => {
            try {
              const needsReason = roomChangeNeedsReason(moveModal.res.status, moveModal.newRoom)
              await api.updateReservation(moveModal.res.id, {
                roomId:       moveModal.newRoomId,
                checkInDate:  moveModal.newCheckIn,
                checkOutDate: moveModal.newCheckOut,
                nights:       moveModal.newNights,
                ...(needsReason ? { changeReason: reason } : {}),
              })
              toast('Reserva movida')
              patchResInState(moveModal.res.id, {
                roomId:       moveModal.newRoomId,
                checkInDate:  moveModal.newCheckIn,
                checkOutDate: moveModal.newCheckOut,
                nights:       moveModal.newNights,
                room:         moveModal.newRoom,
              })
              flashHighlight(moveModal.res.id)
              setMoveModal(null)
            } catch (e: any) { toast(e.message, 'err') }
          }}
        />
      )}

      {resCtxMenu && (
        <ResContextMenuPopup
          x={resCtxMenu.x} y={resCtxMenu.y} res={resCtxMenu.res}
          canDelete={canManage(user)}
          onMoveRoom={() => { setMoveRoomModal({ res: resCtxMenu.res }); setResCtxMenu(null) }}
          onDelete={() => { setDeleteConfirm({ res: resCtxMenu.res }); setResCtxMenu(null) }}
          onClose={() => setResCtxMenu(null)}
        />
      )}

      {deleteConfirm && (
        <DeleteReservationModal
          res={deleteConfirm.res}
          onClose={() => setDeleteConfirm(null)}
          onDeleted={() => { setDeleteConfirm(null); reloadReservations() }}
        />
      )}

      {drawerResId && (
        <ReservationDrawer
          resId={drawerResId}
          onClose={() => { setDrawerResId(null); reloadReservations() }}
        />
      )}

      {moveRoomModal && (
        <MoveToRoomModal
          res={moveRoomModal.res}
          onClose={() => setMoveRoomModal(null)}
          onMoved={(newRoom) => {
            patchResInState(moveRoomModal.res.id, { roomId: newRoom.id, room: newRoom })
            flashHighlight(moveRoomModal.res.id)
            setMoveRoomModal(null)
          }}
        />
      )}
    </div>
  )
}

function occColor(pct: number | null) {
  if (pct === null) return 'var(--text2)'
  if (pct >= 80) return '#22c55e'
  if (pct >= 50) return '#6b93ff'
  return '#f59e0b'
}

function OccCard({ label, pct, sub, wide }: { label: string; pct: number | null; sub: string; wide?: boolean }) {
  const color = occColor(pct)
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 2,
      minWidth: wide ? 200 : 120, flex: wide ? 1 : undefined,
      borderLeft: `3px solid ${color}`,
    }}>
      <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>
        {pct !== null ? `${pct}%` : '—'}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text2)' }}>{sub}</span>
    </div>
  )
}

function OccRateInput({ label, rate, onSave }: { label: string; rate: Rate; onSave: (id: number, v: number) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="occ-rate-item">
      <label>{label}</label>
      <div className="occ-rate-input-wrap">
        <input ref={ref} type="number" defaultValue={parseFloat(rate.adjustValue ?? '0')} min={0} step={0.5} className="occ-price-input" />
        <span className="occ-currency">€</span>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => {
        if (!ref.current) return
        const v = parseFloat(ref.current.value)
        if (!isNaN(v) && v >= 0) onSave(rate.id, v)
      }}>Guardar</button>
    </div>
  )
}

function NewReservationModal({ roomId, roomCode, date, checkOut: initCheckOut, rates, rooms: allRooms, onClose, onCreated }:
  { roomId: number; roomCode: string; date: string; checkOut?: string; rates: Rate[]; rooms: any[];
    onClose: () => void; onCreated: (id: number) => void }) {

  const [channels,      setChannels]      = useState<any[]>([])
  const [checkIn,       setCheckIn]       = useState(date)
  const [checkOut,      setCheckOut]      = useState(initCheckOut ?? addDays(date, 1))
  const [people,        setPeople]        = useState(1)
  const [channelId,     setChannelId]     = useState('')
  const [rateId,        setRateId]        = useState('')
  const [extCode,       setExtCode]       = useState('')
  const [saving,        setSaving]        = useState(false)
  const [extraRoomIds,      setExtraRoomIds]      = useState<number[]>([])
  const [addingRoom,        setAddingRoom]        = useState(false)
  const [newExtraRoomId,    setNewExtraRoomId]    = useState('')
  const [availableForExtra, setAvailableForExtra] = useState<any[]>([])
  const [loadingAvail,      setLoadingAvail]      = useState(false)
  const [calcPrice,     setCalcPrice]     = useState<{ total: number; nights: number; missing: number } | null>(null)
  const [manualTotal,   setManualTotal]   = useState('')

  const [guestQ,        setGuestQ]        = useState('')
  const [guestResults,  setGuestResults]  = useState<any[]>([])
  const [selectedGuest, setSelectedGuest] = useState<{ id: number; label: string; email?: string } | null>(null)
  const [showNewGuest,  setShowNewGuest]  = useState(false)
  const [gFn,  setGFn]  = useState('')
  const [gLn,  setGLn]  = useState('')
  const [gPh,  setGPh]  = useState('')
  const [gEm,  setGEm]  = useState('')
  const [sendConf, setSendConf] = useState(true)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.listChannels().then((r: any) => setChannels(r.data)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!rateId || !checkIn || !checkOut || checkOut <= checkIn) { setCalcPrice(null); return }
    const params = new URLSearchParams({ roomId: String(roomId), rateId, checkIn, checkOut })
    fetch(`/api/reservations/calc-price?${params}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.total !== undefined) setCalcPrice({ total: d.total, nights: d.nights, missing: d.missingDates }) })
      .catch(() => setCalcPrice(null))
  }, [rateId, checkIn, checkOut, roomId])

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
    const label = `${g.firstName} ${g.lastName}${g.email ? ' — ' + g.email : ''}`
    setSelectedGuest({ id: g.id, label, email: g.email || undefined })
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
    if (!selectedGuest)           { toast('Selecciona o crea un huésped', 'err'); return }
    if (!checkIn || !checkOut)    { toast('Completa las fechas', 'err'); return }
    if (checkOut <= checkIn)      { toast('La salida debe ser posterior a la entrada', 'err'); return }
    if (!rateId)                  { toast('Selecciona una tarifa', 'err'); return }
    if (!channelId)               { toast('Selecciona un canal de reserva', 'err'); return }
    if (effectiveTotal <= 0)      { toast('El total debe ser mayor de 0 €', 'err'); return }
    setSaving(true)
    try {
      const res: any = await api.createReservation({
        guestId: selectedGuest.id, roomId,
        checkInDate: checkIn, checkOutDate: checkOut, people,
        bookingChannelId: Number(channelId),
        rateId: Number(rateId),
        total: effectiveTotal,
        externalCode: extCode || undefined,
        ...(extraRoomIds.length > 0 ? { extraRoomIds } : {}),
      })
      if (sendConf && selectedGuest.email) {
        api.sendConfirmation(res.data.id).catch(() => {})
      }
      toast('Reserva creada'); onCreated(res.data.id)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  const openRoomPicker = async () => {
    setAddingRoom(true)
    setNewExtraRoomId('')
    setLoadingAvail(true)
    try {
      const r: any = await api.availableRoomsForReservation({ checkIn, checkOut, excludeRoomId: roomId })
      setAvailableForExtra(r.data.filter((rm: any) => !extraRoomIds.includes(rm.id)))
    } catch { setAvailableForExtra([]) }
    finally { setLoadingAvail(false) }
  }

  const roomsLabel = extraRoomIds.length > 0
    ? `${roomCode} + ${extraRoomIds.map(id => allRooms.find(r => r.id === id)?.code ?? id).join(', ')}`
    : roomCode

  return (
    <Modal title={`Nueva reserva — Hab. ${roomsLabel}`} onClose={onClose} wide footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Crear reserva</button></>
    }>
      <div className="form-grid">
        <div className="form-group full">
          <label>Huésped *</label>
          {selectedGuest
            ? (
              <div className="guest-selected" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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

        <div className="form-group"><label>Fecha entrada</label><input type="date" value={checkIn} onChange={e => setCheckIn(e.target.value)} /></div>
        <div className="form-group"><label>Fecha salida *</label><input type="date" value={checkOut} onChange={e => setCheckOut(e.target.value)} /></div>
        <div className="form-group"><label>Personas</label><input type="number" value={people} min={1} max={20} onChange={e => setPeople(Number(e.target.value))} /></div>
        <div className="form-group">
          <label>Canal *</label>
          <select value={channelId} onChange={e => setChannelId(e.target.value)}>
            <option value="">Seleccionar…</option>
            {channels.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Tarifa *</label>
          <select value={rateId} onChange={e => { setRateId(e.target.value); setManualTotal('') }}>
            <option value="">Seleccionar…</option>
            {rates.map(r => {
              const n = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)
              const min = (r as any).minStay ?? 1
              const max = (r as any).maxStay
              const warn = n < min ? `⚠ mín. ${min}n` : max && n > max ? `⚠ máx. ${max}n` : ''
              return <option key={r.id} value={r.id}>{r.title}{warn ? ` — ${warn}` : ''}</option>
            })}
          </select>
          {(() => {
            const sel = rates.find(r => String(r.id) === rateId)
            if (!sel) return null
            const n   = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)
            const min = (sel as any).minStay ?? 1
            const max = (sel as any).maxStay
            if (n < min) return <div className="form-hint form-hint-warn">Esta tarifa requiere mínimo {min} noches (estancia actual: {n})</div>
            if (max && n > max) return <div className="form-hint form-hint-warn">Esta tarifa permite máximo {max} noches (estancia actual: {n})</div>
            return null
          })()}
        </div>
        <div className="form-group full">
          <label>Total *</label>
          <input type="number" min="0" step="0.01"
            value={manualTotal !== '' ? manualTotal : (calcPrice?.total.toFixed(2) ?? '')}
            onChange={e => setManualTotal(e.target.value)}
            placeholder={calcPrice ? calcPrice.total.toFixed(2) : '0.00'} />
          {calcPrice && (
            <div className="form-hint">
              {calcPrice.missing > 0
                ? `Precio parcial: ${calcPrice.total.toFixed(2)} € (faltan precios para ${calcPrice.missing} noche/s)`
                : `Calculado: ${calcPrice.total.toFixed(2)} € (${calcPrice.nights} noche/s)`}
              {manualTotal !== '' && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }}
                  onClick={() => setManualTotal('')}>
                  Usar precio calculado ({calcPrice.total.toFixed(2)} €)
                </button>
              )}
            </div>
          )}
        </div>

        <div className="form-group full">
          <label>Código externo (Booking, etc.)</label>
          <input type="text" value={extCode} onChange={e => setExtCode(e.target.value)} placeholder="Opcional" />
        </div>

        <div className="form-group full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label>Habitaciones adicionales</label>
          {extraRoomIds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {extraRoomIds.map(id => {
                const r = allRooms.find(r => r.id === id)
                return (
                  <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontSize: 13 }}>
                    Hab. {r?.code ?? id}
                    <button type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', lineHeight: 1 }}
                      onClick={() => setExtraRoomIds(prev => prev.filter(x => x !== id))}>✕</button>
                  </span>
                )
              })}
            </div>
          )}
          {addingRoom ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={newExtraRoomId} onChange={e => setNewExtraRoomId(e.target.value)} style={{ flex: 1 }}
                disabled={loadingAvail}>
                <option value="">{loadingAvail ? 'Cargando…' : availableForExtra.length === 0 ? 'Sin habitaciones disponibles' : 'Selecciona habitación…'}</option>
                {availableForExtra.map(r => (
                  <option key={r.id} value={r.id}>Hab. {r.code}{r.roomType?.name ? ` — ${r.roomType.name}` : ''}</option>
                ))}
              </select>
              <button type="button" className="btn btn-ghost btn-sm" disabled={!newExtraRoomId} onClick={() => {
                if (newExtraRoomId) {
                  setExtraRoomIds(prev => [...prev, Number(newExtraRoomId)])
                  setNewExtraRoomId('')
                }
                setAddingRoom(false)
              }}>Añadir</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAddingRoom(false); setNewExtraRoomId('') }}>Cancelar</button>
            </div>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={openRoomPicker}>
              + Añadir habitación
            </button>
          )}
        </div>
        {selectedGuest?.email && (
          <div className="form-group full" style={{ marginTop: 4 }}>
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

// ─── Menú contextual ──────────────────────────────────────────────────────────

function ContextMenuPopup({ x, y, isBlocked, blockId, blockLocked, onNewReservation, onBlock, onUnblock, onClose }:
  { x: number; y: number; isBlocked: boolean; blockId?: number; blockLocked?: boolean
    onNewReservation: () => void; onBlock: () => void
    onUnblock: (id: number) => void; onClose: () => void }) {

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!(e.target as Element)?.closest('.ctx-menu')) onClose() }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  // Adjust so menu doesn't go off-screen
  const menuW = 200, menuH = 90
  const left = x + menuW > window.innerWidth  ? x - menuW : x
  const top  = y + menuH > window.innerHeight ? y - menuH : y

  return createPortal(
    <div className="ctx-menu" style={{ left, top }} onClick={e => e.stopPropagation()}>
      {!isBlocked && (
        <button className="ctx-item" onClick={onNewReservation}>
          <span className="ctx-icon">＋</span> Nueva reserva
        </button>
      )}
      {!isBlocked && (
        <button className="ctx-item ctx-item-warn" onClick={onBlock}>
          <span className="ctx-icon">🚫</span> Bloquear plaza
        </button>
      )}
      {isBlocked && blockLocked && (
        <div className="ctx-item" style={{ opacity: .7, cursor: 'default' }}><span className="ctx-icon">🔒</span> Bloqueo de Dirección</div>
      )}
      {isBlocked && blockId != null && !blockLocked && (
        <button className="ctx-item ctx-item-ok" onClick={() => onUnblock(blockId)}>
          <span className="ctx-icon">✓</span> Desbloquear
        </button>
      )}
    </div>,
    document.body
  )
}

// ─── Modal de bloqueo ─────────────────────────────────────────────────────────

function RangeMenu({ x, y, checkIn, checkOut, onNewRes, onBlock, onClose }: {
  x: number; y: number; checkIn: string; checkOut: string
  onNewRes: () => void; onBlock: () => void; onClose: () => void
}) {
  useEffect(() => {
    const hide = (e: MouseEvent) => {
      const el = document.getElementById('planning-range-menu')
      if (el && !el.contains(e.target as Node)) onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', hide), 50)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', hide) }
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed', zIndex: 500,
    top: y + 8, left: Math.max(4, Math.min(x - 60, window.innerWidth - 220)),
    background: 'var(--bg2)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '8px 10px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
    display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200,
  }
  return (
    <div id="planning-range-menu" style={style}>
      <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, marginBottom: 2 }}>
        {checkIn} → {checkOut}
      </div>
      <button className="btn btn-primary btn-sm" onClick={onNewRes}>+ Crear reserva</button>
      <button className="btn btn-danger btn-sm" onClick={onBlock}>⊠ Bloquear habitación</button>
    </div>
  )
}

function BlockModal({ roomCode, date, dateEnd, bedNumber, canLock, onClose, onSaved }:
  { roomCode: string; date: string; dateEnd?: string; bedNumber: string; canLock?: boolean; onClose: () => void; onSaved: (reason: string, locked: boolean) => Promise<void> }) {
  const [locked, setLocked] = useState(false)
  const isRange = dateEnd && dateEnd !== date
  const [reason,  setReason]  = useState('')
  const [saving,  setSaving]  = useState(false)

  const save = async () => {
    setSaving(true)
    await onSaved(reason, locked)
    setSaving(false)
  }

  return (
    <Modal title={`Bloquear plaza — Hab. ${roomCode} · ${isRange ? `${date} → ${dateEnd}` : date}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-danger" onClick={save} disabled={saving}>Bloquear</button></>
    }>
      <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 12 }}>
        Plaza {bedNumber} bloqueada para esta fecha. No se podrán asignar reservas.
      </p>
      <div className="form-group">
        <label>Motivo (opcional)</label>
        <input value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Mantenimiento, limpieza…" autoFocus />
      </div>
      {canLock && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} />
          🔒 Bloqueo de Dirección (inamovible: solo Dirección podrá quitarlo, no se sugerirá venderla)
        </label>
      )}
    </Modal>
  )
}

// ─── Modal confirmación de movimiento (drag) ──────────────────────────────────

function MoveConfirmModal({ res, newRoom, newCheckIn, newCheckOut, newNights, onClose, onConfirm }:
  { res: any; newRoom: any; newCheckIn: string; newCheckOut: string; newNights: number
    onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {

  const [saving, setSaving] = useState(false)
  const [reason, setReason] = useState('')
  const oldRoom     = res.room
  const roomChanged = newRoom?.id !== oldRoom?.id
  const dateChanged = newCheckIn !== res.checkInDate
  const needsReason = roomChanged && roomChangeNeedsReason(res.status, newRoom)
  const reasonOk     = !needsReason || countReasonWords(reason) >= MIN_REASON_WORDS

  const fmt = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
  const confirm = async () => { setSaving(true); await onConfirm(reason); setSaving(false) }

  return (
    <Modal title="Confirmar movimiento de reserva" onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={confirm} disabled={saving || !reasonOk}>Confirmar</button></>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f59e0b', display: 'flex', gap: 8 }}>
          <span>⚠</span>
          <span>Estás modificando la reserva <strong>#{res.id}</strong> de {res.guest ? `${res.guest.firstName} ${res.guest.lastName}` : '—'}. El precio original se mantiene sin cambios.</span>
        </div>

        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', paddingBottom: 4, color: 'var(--text2)', fontWeight: 500 }}></th>
              <th style={{ textAlign: 'center', paddingBottom: 4, color: 'var(--text2)', fontWeight: 500 }}>Actual</th>
              <th style={{ textAlign: 'center', paddingBottom: 4, color: 'var(--text2)', fontWeight: 500 }}>Nuevo</th>
            </tr>
          </thead>
          <tbody>
            {roomChanged && (
              <tr>
                <td style={{ padding: '5px 0', color: 'var(--text2)' }}>Habitación</td>
                <td style={{ textAlign: 'center' }}>{oldRoom?.code ?? '—'}</td>
                <td style={{ textAlign: 'center', color: 'var(--accent)', fontWeight: 600 }}>{newRoom?.code ?? '—'}</td>
              </tr>
            )}
            {dateChanged && (
              <>
                <tr>
                  <td style={{ padding: '5px 0', color: 'var(--text2)' }}>Entrada</td>
                  <td style={{ textAlign: 'center' }}>{fmt(res.checkInDate)}</td>
                  <td style={{ textAlign: 'center', color: 'var(--accent)', fontWeight: 600 }}>{fmt(newCheckIn)}</td>
                </tr>
                <tr>
                  <td style={{ padding: '5px 0', color: 'var(--text2)' }}>Salida</td>
                  <td style={{ textAlign: 'center' }}>{fmt(res.checkOutDate)}</td>
                  <td style={{ textAlign: 'center', color: 'var(--accent)', fontWeight: 600 }}>{fmt(newCheckOut)}</td>
                </tr>
                <tr>
                  <td style={{ padding: '5px 0', color: 'var(--text2)' }}>Noches</td>
                  <td style={{ textAlign: 'center' }}>
                    {Math.round((new Date(res.checkOutDate).getTime() - new Date(res.checkInDate).getTime()) / 86400000)}
                  </td>
                  <td style={{ textAlign: 'center', color: 'var(--accent)', fontWeight: 600 }}>{newNights}</td>
                </tr>
              </>
            )}
            <tr>
              <td style={{ padding: '5px 0', color: 'var(--text2)' }}>Precio total</td>
              <td style={{ textAlign: 'center' }} colSpan={2}>
                <strong>{parseFloat(res.total ?? '0').toFixed(2)} €</strong>
                <span style={{ marginLeft: 8, fontSize: 11, color: '#22c55e', fontWeight: 600 }}>✓ sin cambios</span>
              </td>
            </tr>
          </tbody>
        </table>
        {needsReason && <RoomChangeReasonField value={reason} onChange={setReason} reservationStatus={res.status} targetRoom={newRoom} />}
      </div>
    </Modal>
  )
}

// ─── Menú contextual sobre reserva ────────────────────────────────────────────

function ResContextMenuPopup({ x, y, res, canDelete, onMoveRoom, onDelete, onClose }:
  { x: number; y: number; res: any; canDelete?: boolean; onMoveRoom: () => void; onDelete: () => void; onClose: () => void }) {

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!(e.target as Element)?.closest('.ctx-menu')) onClose() }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  const menuW = 200, menuH = canDelete ? 90 : 60
  const left = x + menuW > window.innerWidth  ? x - menuW : x
  const top  = y + menuH > window.innerHeight ? y - menuH : y

  return createPortal(
    <div className="ctx-menu" style={{ left, top }} onClick={e => e.stopPropagation()}>
      <div style={{ padding: '4px 12px 6px', fontSize: 11, color: 'var(--text2)', borderBottom: '1px solid var(--border)' }}>
        Reserva #{res.id} · {res.guest ? `${res.guest.firstName} ${res.guest.lastName}` : '—'}
      </div>
      <button className="ctx-item" onClick={onMoveRoom}>
        <span className="ctx-icon">⇄</span> Cambiar habitación
      </button>
      {canDelete && (
        <button className="ctx-item" style={{ color: 'var(--red)' }} onClick={onDelete}>
          <span className="ctx-icon">🗑</span> Eliminar reserva
        </button>
      )}
    </div>,
    document.body
  )
}

// ─── Modal confirmación eliminar reserva ─────────────────────────────────────

function DeleteReservationModal({ res, onClose, onDeleted }:
  { res: any; onClose: () => void; onDeleted: () => void }) {
  const [loading, setLoading] = useState(false)

  const doDelete = async () => {
    setLoading(true)
    try {
      await api.deleteReservation(res.id)
      toast(`Reserva #${res.id} eliminada`)
      onDeleted()
    } catch (e: any) {
      toast(e.message ?? 'Error al eliminar', 'err')
      setLoading(false)
    }
  }

  const guest = res.guest ? `${res.guest.firstName} ${res.guest.lastName}` : '—'

  return (
    <Modal title="Eliminar reserva" onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancelar</button>
        <button className="btn" style={{ background: 'var(--red)', color: '#fff' }} onClick={doDelete} disabled={loading}>
          {loading ? 'Eliminando…' : 'Eliminar definitivamente'}
        </button>
      </>
    }>
      <p style={{ marginBottom: 12 }}>
        ¿Eliminar la reserva <strong>#{res.id}</strong> de <strong>{guest}</strong>?
      </p>
      <p style={{ color: 'var(--red)', fontSize: 13 }}>
        Esta acción es irreversible. Se borrarán también las noches, notas, extras, transacciones y facturas asociadas.
      </p>
    </Modal>
  )
}

// ─── Modal cambiar habitación (desde click derecho) ───────────────────────────

function MoveToRoomModal({ res, onClose, onMoved }:
  { res: any; onClose: () => void; onMoved: (newRoom: any) => void }) {

  const [availRooms, setAvailRooms] = useState<any[]>([])
  const [loading,    setLoading]    = useState(true)
  const [typeId,     setTypeId]     = useState('')
  const [roomId,     setRoomId]     = useState('')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)

  useEffect(() => {
    api.availableRoomsForReservation({
      checkIn:        res.checkInDate,
      checkOut:       res.checkOutDate,
      excludeRoomId:  res.roomId,
      includeVirtual: true,
    }).then((r: any) => setAvailRooms(r.data))
      .catch(() => setAvailRooms([]))
      .finally(() => setLoading(false))
  }, [])

  const roomTypes = [...new Map(
    availRooms.filter(r => r.roomType).map(r => [r.roomTypeId, r.roomType])
  ).values()].sort((a, b) => a.name.localeCompare(b.name))

  const filtered = typeId
    ? availRooms.filter(r => r.roomTypeId === Number(typeId))
    : []

  const selectedRoom = availRooms.find(r => r.id === Number(roomId))
  const fmt = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })

  const needsReason = roomChangeNeedsReason(res.status, selectedRoom)
  const reasonOk     = !needsReason || countReasonWords(reason) >= MIN_REASON_WORDS

  const save = async () => {
    if (!roomId || !selectedRoom) { toast('Selecciona una habitación', 'err'); return }
    setSaving(true)
    try {
      await api.updateReservation(res.id, { roomId: Number(roomId), ...(needsReason ? { changeReason: reason } : {}) })
      toast(`Reserva #${res.id} movida a hab. ${selectedRoom.code}`)
      onMoved(selectedRoom)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={`Cambiar habitación — Reserva #${res.id}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !roomId || !reasonOk}>Mover reserva</button></>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text2)', background: 'var(--bg2)', borderRadius: 8, padding: '10px 14px' }}>
          <strong>{res.guest ? `${res.guest.firstName} ${res.guest.lastName}` : '—'}</strong>
          <span style={{ marginLeft: 10 }}>{fmt(res.checkInDate)} → {fmt(res.checkOutDate)}</span>
          <span style={{ marginLeft: 10, color: 'var(--text2)' }}>Hab. actual: <strong>{res.room?.code ?? '—'}</strong></span>
        </div>

        {loading ? (
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>Cargando habitaciones disponibles…</p>
        ) : availRooms.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No hay habitaciones disponibles para estas fechas</p>
        ) : (
          <>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>1. Tipo de habitación</label>
              <select value={typeId} onChange={e => { setTypeId(e.target.value); setRoomId('') }} autoFocus>
                <option value="">— Selecciona tipo —</option>
                {roomTypes.map((rt: any) => (
                  <option key={rt.id} value={rt.id}>{rt.name}</option>
                ))}
              </select>
            </div>

            {typeId && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>2. Habitación</label>
                {filtered.length === 0
                  ? <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>No hay habitaciones disponibles de este tipo</p>
                  : (
                    <select value={roomId} onChange={e => setRoomId(e.target.value)}>
                      <option value="">— Selecciona habitación —</option>
                      {filtered.map((r: any) => (
                        <option key={r.id} value={r.id}>Hab. {r.code}</option>
                      ))}
                    </select>
                  )
                }
              </div>
            )}
            <RoomChangeReasonField value={reason} onChange={setReason} reservationStatus={res.status} targetRoom={selectedRoom} />
          </>
        )}

        {selectedRoom && (
          <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
            ✓ Se moverá a hab. {selectedRoom.code} ({selectedRoom.roomType?.name}) · fechas y precio sin cambios
          </div>
        )}
      </div>
    </Modal>
  )
}

// ─── Dropdown "Ir a" ──────────────────────────────────────────────────────────

function GotoDropdown({ onSelect, onClose }: { onSelect: (preset: string) => void; onClose: () => void }) {
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!(e.target as Element)?.closest('.plan-goto-wrap')) onClose() }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  return (
    <div className="plan-goto-menu">
      <button className="plan-goto-item" onClick={() => onSelect('today')}>Hoy</button>
      <button className="plan-goto-item" onClick={() => onSelect('ayer')}>Ayer</button>
      <button className="plan-goto-item" onClick={() => onSelect('mes')}>Hace un mes</button>
      <button className="plan-goto-item" onClick={() => onSelect('anio')}>Hace un año</button>
    </div>
  )
}

function FdmSyncButton({ onDone }: { onDone: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [msg,     setMsg]     = useState<string | null>(null)

  const run = async () => {
    setSyncing(true); setMsg(null)
    try {
      // Rango fijo (no depende de lo que se esté viendo en el planning): desde
      // ayer hasta dentro de un año, para no perder altas/cambios fuera de vista
      const from = addDays(today(), -1)
      const to   = addDays(today(), 365)
      const r = await api.fdmSyncReservations(from, to)
      const { imported, updated, errors, invImported, txImported } = r.data
      const parts = [`+${imported} res.`, `${updated} act.`]
      if (invImported > 0) parts.push(`+${invImported} fact.`)
      if (txImported  > 0) parts.push(`+${txImported} tx`)
      if (errors      > 0) parts.push(`${errors} err`)
      setMsg(`✔ ${parts.join(' · ')}`)
      onDone()
    } catch (e: any) {
      setMsg(`✗ ${e.message}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setMsg(null), 5000)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button className="btn btn-ghost btn-sm" onClick={run} disabled={syncing} title="Sincronizar reservas desde ayer hasta dentro de un año">
        {syncing ? '…' : '↺ FDM'}
      </button>
      {msg && <span style={{ fontSize: 11, color: msg.startsWith('✔') ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>{msg}</span>}
    </div>
  )
}
