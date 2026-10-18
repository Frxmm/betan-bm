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

// Recorta/escala un frame de vídeo a un tamaño razonable antes de subirlo
// (más rápido, y de sobra para que la IA lea el texto bien).
function videoFrameToDataUrl(video: HTMLVideoElement, maxDim = 1600, quality = 0.85): string {
  let width = video.videoWidth
  let height = video.videoHeight
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height)
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
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

  const [doneToday, setDoneToday] = useState<Awaited<ReturnType<typeof api.idScanDoneToday>>['data']>([])
  const loadDoneToday = useCallback(async () => {
    try {
      const r = await api.idScanDoneToday()
      setDoneToday(r.data)
    } catch (e: any) { toast(e.message, 'err') }
  }, [])
  useEffect(() => { loadDoneToday() }, [loadDoneToday])

  const selectedRes = arrivals.find(r => r.id === resId) ?? null

  const slots: Slot[] = slotsData ? [
    { key: 'primary', label: 'Titular', guestId: slotsData.primary?.id ?? null, current: slotsData.primary },
    ...slotsData.additional.map((g: any, i: number) => ({ key: `guest-${g.id}`, label: `Huésped ${i + 2}`, guestId: g.id, current: g })),
    ...Array.from({ length: slotsData.emptySlots }, (_, i) => ({
      key: `new-${i}`, label: `Huésped ${slotsData.additional.length + i + 2}`, guestId: null, current: null,
    })),
  ] : []

  const closeReview = () => { setActiveSlot(null); if (resId != null) loadSlots(resId); loadDoneToday() }

  function fmtScanTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="view-container" style={{ maxWidth: 560 }}>
      <div className="view-header">
        <div>
          <h2>Escaneo de documentos</h2>
          <p className="view-subtitle">Check-in rápido con la cámara — solo llegadas de hoy</p>
        </div>
      </div>

      {resId == null ? (
        <>
          {loading ? (
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
          )}

          {doneToday.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>Ya realizados hoy ({doneToday.length})</h3>
              <div className="hk-list">
                {doneToday.map(d => (
                  <div key={d.guest_id} className="card" style={{ padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{d.first_name} {d.last_name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                        {d.room_code ? `Hab. ${d.room_code} · ` : ''}{d.emp_first_name ? `${d.emp_first_name} ${d.emp_last_name ?? ''}` : 'empleado desconocido'}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', flexShrink: 0 }}>{fmtScanTime(d.scanned_at)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
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

// Parámetros de la detección de "quietud" para disparar la foto sola: se
// comparan muestras pequeñas (en gris) del vídeo a intervalos; si la
// diferencia media entre muestras consecutivas se mantiene por debajo del
// umbral varias veces seguidas, se considera que el documento está bien
// encuadrado y quieto y se captura automáticamente.
const STILL_SAMPLE_SIZE   = 48
const STILL_THRESHOLD     = 6
const STILL_FRAMES_NEEDED = 5
// 2.5s da tiempo real a coger el móvil, encuadrar el documento dentro de la
// guía y sujetarlo — con menos, si la cámara ya estaba quieta desde el
// principio (apoyada, o el usuario tarda en moverla), podía disparar casi al
// instante sin dejar centrar el documento.
const STILL_WARMUP_MS     = 2500

function ScanModal({ reservationId, slot, onClose }: { reservationId: number; slot: Slot; onClose: () => void }) {
  const [phase, setPhase]   = useState<ScanPhase>('camera')
  const [note,  setNote]    = useState('')
  const [docError, setDocError] = useState('')
  const [saving, setSaving] = useState(false)
  const [camError, setCamError]   = useState('')
  const [camStatus, setCamStatus] = useState('Preparando cámara…')
  const [camAttempt, setCamAttempt] = useState(0)

  const videoRef      = useRef<HTMLVideoElement>(null)
  const streamRef      = useRef<MediaStream | null>(null)
  const diffCanvasRef  = useRef<HTMLCanvasElement | null>(null)
  const rafRef         = useRef<number | null>(null)
  const prevFrameRef   = useRef<Uint8ClampedArray | null>(null)
  const stillCountRef  = useRef(0)
  const startedAtRef   = useRef(0)
  const capturedRef    = useRef(false)

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

  const applyExtractedFields = (d: any) => {
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
  }

  const stopCamera = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const doCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video || capturedRef.current) return
    capturedRef.current = true
    stopCamera()
    const dataUrl = videoFrameToDataUrl(video)
    setPhase('extracting')
    try {
      const r = await api.idScanExtract(dataUrl)
      applyExtractedFields(r.data)
      setPhase('review')
    } catch (err: any) {
      toast(err.message, 'err')
      setPhase('camera')
    }
  }, [stopCamera])

  // Bucle de muestreo para detectar "quietud" y disparar la foto sin que el
  // usuario tenga que pulsar nada — compara cada muestra en gris con la
  // anterior; si varias seguidas casi no cambian, se da por bien encuadrado.
  const sampleLoop = useCallback(() => {
    const video = videoRef.current
    if (!video || capturedRef.current) return
    if (video.readyState < 2) { rafRef.current = requestAnimationFrame(sampleLoop); return }
    if (!diffCanvasRef.current) diffCanvasRef.current = document.createElement('canvas')
    const canvas = diffCanvasRef.current
    canvas.width = STILL_SAMPLE_SIZE
    canvas.height = STILL_SAMPLE_SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) { rafRef.current = requestAnimationFrame(sampleLoop); return }
    ctx.drawImage(video, 0, 0, STILL_SAMPLE_SIZE, STILL_SAMPLE_SIZE)
    const pixels = ctx.getImageData(0, 0, STILL_SAMPLE_SIZE, STILL_SAMPLE_SIZE).data
    const gray = new Uint8ClampedArray(STILL_SAMPLE_SIZE * STILL_SAMPLE_SIZE)
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4
      gray[i] = pixels[o]! * 0.299 + pixels[o + 1]! * 0.587 + pixels[o + 2]! * 0.114
    }
    const prev = prevFrameRef.current
    if (prev && Date.now() - startedAtRef.current > STILL_WARMUP_MS) {
      let diffSum = 0
      for (let i = 0; i < gray.length; i++) diffSum += Math.abs(gray[i]! - prev[i]!)
      if (diffSum / gray.length < STILL_THRESHOLD) {
        stillCountRef.current++
        if (stillCountRef.current >= STILL_FRAMES_NEEDED) { doCapture(); return }
      } else {
        stillCountRef.current = 0
      }
    }
    prevFrameRef.current = gray
    rafRef.current = requestAnimationFrame(sampleLoop)
  }, [doCapture])

  useEffect(() => {
    if (phase !== 'camera') return
    capturedRef.current = false
    stillCountRef.current = 0
    prevFrameRef.current = null
    setCamError('')
    setCamStatus('Preparando cámara…')
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(stream => {
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
        startedAtRef.current = Date.now()
        setCamStatus('Encuadra el documento dentro del marco y sujétalo quieto — se hace la foto sola')
        rafRef.current = requestAnimationFrame(sampleLoop)
      })
      .catch(() => {
        setCamError('No se pudo acceder a la cámara. Revisa los permisos del navegador para esta página.')
      })
    return () => { cancelled = true; stopCamera() }
  }, [phase, camAttempt, sampleLoop, stopCamera])

  useEffect(() => stopCamera, [stopCamera])

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
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            {camError ? (
              <div style={{ padding: '24px 0' }}>
                <p style={{ fontSize: 13, color: 'var(--red)', marginBottom: 16 }}>{camError}</p>
                <button className="btn btn-primary" onClick={() => setCamAttempt(n => n + 1)}>Reintentar</button>
              </div>
            ) : (
              <>
                <div style={{
                  position: 'relative', borderRadius: 10, overflow: 'hidden',
                  background: '#000', aspectRatio: '4 / 3', marginBottom: 10,
                }}>
                  <video ref={videoRef} autoPlay playsInline muted
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  {/* Guía visual: proporción típica de un DNI/carnet (ISO/IEC 7810 ID-1,
                      ~1,586:1) centrada, para saber dónde encuadrar el documento —
                      antes no había ninguna referencia, solo el texto de abajo. */}
                  <div style={{
                    position: 'absolute', inset: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
                  }}>
                    <div style={{
                      width: '82%', aspectRatio: '1.586 / 1',
                      border: '3px dashed rgba(255,255,255,.85)', borderRadius: 12,
                      boxShadow: '0 0 0 2000px rgba(0,0,0,.35)',
                    }} />
                  </div>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>{camStatus}</p>
                <button className="btn btn-primary" style={{ fontSize: 15, padding: '12px 24px' }} onClick={doCapture}>
                  📷 Capturar ahora
                </button>
              </>
            )}
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
