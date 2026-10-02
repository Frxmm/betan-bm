import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import { toast } from '../lib/utils'
import { validateIdDocNumber } from '../lib/idDocValidation'

// ─── Escaneo de documentos de identidad (check-in rápido) ──────────────────
// Recepción fotografía el DNI/NIE/pasaporte con la cámara del móvil, la IA
// lee los datos (POST /api/id-scan/extract), se revisan/corrigen en pantalla
// y se guardan sobre el huésped correspondiente (POST /api/id-scan/:id/apply)
// — primero el titular, luego los demás huéspedes de la reserva. Solo
// funciona sobre reservas con check-in HOY en estado "Por llegar"/"Confirmada"
// (lo exige también el backend, esto solo evita listar las que no valen).

const DOC_TYPE_LABEL: Record<string, string> = {
  dni: 'DNI', nie: 'NIE', passport: 'Pasaporte', driving_licence: 'Carnet', other: 'Otro',
}

function todayMadrid(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
}

// Las fotos de cámara de un móvil pueden pesar varios MB — se reduce a un
// tamaño razonable antes de subirla (más rápido, y de sobra para que la IA
// lea el texto bien).
function downscaleToDataUrl(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('No se pudo procesar la imagen')); return }
      ctx.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')) }
    img.src = url
  })
}

interface Slot {
  key: string                 // 'primary' o guestId numérico en string, o 'new-N' si está vacío
  label: string                // "Titular" / "Huésped 2"
  guestId: number | null       // null = hueco vacío, aún sin huésped creado
  current: any | null          // datos ya guardados, si los hay
}

export default function IdScanView() {
  const [arrivals,  setArrivals]  = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [resId,     setResId]     = useState<number | null>(null)
  const [slotsData, setSlotsData] = useState<{ people: number; primary: any; additional: any[]; emptySlots: number } | null>(null)
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [activeSlot, setActiveSlot] = useState<Slot | null>(null)

  const loadArrivals = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.arrivals(todayMadrid())
      setArrivals((r.data ?? []).filter((res: any) => ['arriving', 'confirmed'].includes(res.status)))
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadArrivals() }, [loadArrivals])

  const loadSlots = useCallback(async (id: number) => {
    setLoadingSlots(true)
    try {
      const r = await api.idScanSlots(id)
      setSlotsData(r.data)
    } catch (e: any) { toast(e.message, 'err'); setResId(null) }
    finally { setLoadingSlots(false) }
  }, [])

  useEffect(() => { if (resId != null) loadSlots(resId) }, [resId, loadSlots])

  const selectedRes = arrivals.find(r => r.id === resId) ?? null

  const slots: Slot[] = slotsData ? [
    { key: 'primary', label: 'Titular', guestId: slotsData.primary?.id ?? null, current: slotsData.primary },
    ...slotsData.additional.map((g: any, i: number) => ({ key: `guest-${g.id}`, label: `Huésped ${i + 2}`, guestId: g.id, current: g })),
    ...Array.from({ length: slotsData.emptySlots }, (_, i) => ({
      key: `new-${i}`, label: `Huésped ${slotsData.additional.length + i + 2}`, guestId: null, current: null,
    })),
  ] : []

  const closeReview = () => { setActiveSlot(null); if (resId != null) loadSlots(resId) }

  return (
    <div className="view-container" style={{ maxWidth: 560 }}>
      <div className="view-header">
        <div>
          <h2>Escaneo de documentos</h2>
          <p className="view-subtitle">Check-in rápido con la cámara — solo llegadas de hoy</p>
        </div>
      </div>

      {resId == null ? (
        loading ? (
          <div className="loading">Cargando…</div>
        ) : arrivals.length === 0 ? (
          <div className="empty"><p>No hay llegadas pendientes para hoy</p></div>
        ) : (
          <div className="hk-list">
            {arrivals.map(res => (
              <button key={res.id} onClick={() => setResId(res.id)}
                className="card" style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', textAlign: 'left', padding: '14px 16px', cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg2)',
                }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{res.guest?.firstName} {res.guest?.lastName}</div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                    Hab. {res.room?.code ?? '—'} · {res.people} persona{res.people === 1 ? '' : 's'} · {res.bookingChannel?.name ?? '—'}
                  </div>
                </div>
                <span style={{ fontSize: 20, color: 'var(--text2)' }}>›</span>
              </button>
            ))}
          </div>
        )
      ) : (
        <>
          <button className="btn btn-ghost btn-xs" style={{ marginBottom: 12 }} onClick={() => { setResId(null); setSlotsData(null) }}>
            ← Volver a la lista
          </button>
          {selectedRes && (
            <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontWeight: 600 }}>{selectedRes.guest?.firstName} {selectedRes.guest?.lastName}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>Hab. {selectedRes.room?.code ?? '—'} · {selectedRes.people} persona{selectedRes.people === 1 ? '' : 's'}</div>
            </div>
          )}

          {loadingSlots ? (
            <div className="loading">Cargando…</div>
          ) : (
            <div className="hk-list">
              {slots.map(slot => (
                <div key={slot.key} className="card" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{slot.label}</div>
                    {slot.current ? (
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                        {slot.current.firstName} {slot.current.lastName} {slot.current.secondLastName ?? ''}
                        {slot.current.idDocNumber && (
                          <> · {DOC_TYPE_LABEL[slot.current.idDocType] ?? slot.current.idDocType} {slot.current.idDocNumber}</>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text3, var(--text2))', marginTop: 2 }}>Sin datos todavía</div>
                    )}
                  </div>
                  <button className="btn btn-primary btn-xs" style={{ flexShrink: 0 }} onClick={() => setActiveSlot(slot)}>
                    📷 Escanear
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeSlot && resId != null && (
        <ScanModal reservationId={resId} slot={activeSlot} onClose={closeReview} />
      )}
    </div>
  )
}

// ─── Flujo de un huésped: cámara → extracción → revisión → guardar ─────────

type ScanPhase = 'camera' | 'extracting' | 'review'

function ScanModal({ reservationId, slot, onClose }: { reservationId: number; slot: Slot; onClose: () => void }) {
  const [phase, setPhase]   = useState<ScanPhase>('camera')
  const [note,  setNote]    = useState('')
  const [docError, setDocError] = useState('')
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState({
    firstName: slot.current?.firstName ?? '',
    lastName: slot.current?.lastName ?? '',
    secondLastName: slot.current?.secondLastName ?? '',
    gender: slot.current?.gender ?? 'unspecified',
    dateOfBirth: slot.current?.dateOfBirth ?? '',
    nationality: slot.current?.nationality ?? '',
    idDocType: slot.current?.idDocType ?? '',
    idDocNumber: slot.current?.idDocNumber ?? '',
    idDocSupportNumber: slot.current?.idDocSupportNumber ?? '',
    idDocIssueDate: slot.current?.idDocIssueDate ?? '',
    idDocExpiryDate: slot.current?.idDocExpiryDate ?? '',
  })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPhase('extracting')
    try {
      const dataUrl = await downscaleToDataUrl(file)
      const r = await api.idScanExtract(dataUrl)
      const d: any = r.data
      setForm(f => ({
        ...f,
        firstName: d.firstName ?? f.firstName,
        lastName: d.lastName ?? f.lastName,
        secondLastName: d.secondLastName ?? f.secondLastName,
        gender: d.gender ?? f.gender,
        dateOfBirth: d.dateOfBirth ?? f.dateOfBirth,
        nationality: d.nationality ?? f.nationality,
        idDocType: d.idDocType ?? f.idDocType,
        idDocNumber: d.idDocNumber ?? f.idDocNumber,
        idDocSupportNumber: d.idDocSupportNumber ?? f.idDocSupportNumber,
        idDocIssueDate: d.idDocIssueDate ?? f.idDocIssueDate,
        idDocExpiryDate: d.idDocExpiryDate ?? f.idDocExpiryDate,
      }))
      setNote(d.lowConfidenceNote ?? '')
      setPhase('review')
    } catch (err: any) {
      toast(err.message, 'err')
      setPhase('camera')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const save = async () => {
    const err = validateIdDocNumber(form.idDocType, form.idDocNumber)
    if (err) { setDocError(err); return }
    if (!form.firstName.trim() || !form.lastName.trim()) { toast('Nombre y apellido son obligatorios', 'err'); return }
    setSaving(true)
    try {
      const fields = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
      await api.idScanApply(reservationId, { guestId: slot.guestId ?? undefined, fields })
      toast('Datos guardados')
      onClose()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1300,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg2)', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 560,
        maxHeight: '92vh', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{slot.label}</h3>
          <button className="btn btn-ghost btn-xs" onClick={onClose}>✕</button>
        </div>

        {phase === 'camera' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>
              Haz una foto del DNI, NIE o pasaporte — bien iluminado y sin reflejos.
            </p>
            <input
              ref={fileInputRef} type="file" accept="image/*" capture="environment"
              onChange={onFileChosen} style={{ display: 'none' }} id="id-scan-file"
            />
            <label htmlFor="id-scan-file" className="btn btn-primary" style={{ fontSize: 16, padding: '14px 28px', cursor: 'pointer' }}>
              📷 Abrir cámara
            </label>
          </div>
        )}

        {phase === 'extracting' && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text2)' }}>Leyendo el documento…</div>
        )}

        {phase === 'review' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {note && (
              <div className="alert-error" style={{ fontSize: 12 }}>⚠️ {note} — revisa estos datos con cuidado</div>
            )}
            <div className="form-grid">
              <div className="form-group"><label>Nombre *</label><input value={form.firstName} onChange={set('firstName')} /></div>
              <div className="form-group"><label>Primer apellido *</label><input value={form.lastName} onChange={set('lastName')} /></div>
              <div className="form-group"><label>Segundo apellido</label><input value={form.secondLastName} onChange={set('secondLastName')} /></div>
              <div className="form-group">
                <label>Sexo</label>
                <select value={form.gender} onChange={set('gender')}>
                  <option value="unspecified">Sin especificar</option>
                  <option value="male">Hombre</option>
                  <option value="female">Mujer</option>
                  <option value="non_binary">No binario</option>
                </select>
              </div>
              <div className="form-group"><label>Fecha de nacimiento</label><input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></div>
              <div className="form-group"><label>Nacionalidad</label><input value={form.nationality} onChange={set('nationality')} /></div>
              <div className="form-group">
                <label>Tipo de documento</label>
                <select value={form.idDocType} onChange={set('idDocType')}>
                  <option value="">—</option>
                  <option value="dni">DNI</option>
                  <option value="nie">NIE</option>
                  <option value="passport">Pasaporte</option>
                  <option value="driving_licence">Carnet de conducir</option>
                  <option value="other">Otro</option>
                </select>
              </div>
              <div className="form-group"><label>Número de documento</label><input value={form.idDocNumber} onChange={set('idDocNumber')} /></div>
              {(form.idDocType === 'dni' || form.idDocType === 'nie') && (
                <div className="form-group"><label>Nº de soporte</label><input value={form.idDocSupportNumber} onChange={set('idDocSupportNumber')} /></div>
              )}
              <div className="form-group"><label>Fecha de expedición</label><input type="date" value={form.idDocIssueDate} onChange={set('idDocIssueDate')} /></div>
              <div className="form-group"><label>Fecha de caducidad</label><input type="date" value={form.idDocExpiryDate} onChange={set('idDocExpiryDate')} /></div>
            </div>
            {docError && <p style={{ color: 'var(--red)', fontSize: 13, margin: 0 }}>{docError}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={() => setPhase('camera')}>Repetir foto</button>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={save}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
