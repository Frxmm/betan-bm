import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Modal } from '../components/Modal'
import { toast, fmtMoney, fmtDate, STATUS_LABEL } from '../lib/utils'

const STATUS: Record<string, { label: string; color: string }> = {
  draft:    { label: 'Borrador',   color: 'var(--text2)' },
  sent:     { label: 'Enviada',    color: '#2563eb' },
  accepted: { label: 'Aceptada',   color: 'var(--green)' },
  rejected: { label: 'Rechazada',  color: 'var(--red)' },
  expired:  { label: 'Caducada',   color: 'var(--text2)' },
}

export default function CorporateReport() {
  const navigate = useNavigate()
  const [companies, setCompanies] = useState<any[]>([])
  const [offers, setOffers]       = useState<any[]>([])
  const [modal, setModal]         = useState<{ name: string; nif: string } | null>(null)
  const [loading, setLoading]     = useState(false)
  const [expanded, setExpanded]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, o] = await Promise.all([api.listCorporateCompanies(), api.listCorporateOffers()])
      setCompanies(c.data); setOffers(o.data)
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const setStatus = async (id: number, status: string) => {
    try { await api.setCorporateOfferStatus(id, status); load() } catch (e: any) { toast(e.message, 'err') }
  }

  return (
    <>
      <h2 style={{ margin: '0 0 4px' }}>Empresas candidatas a precio fijo semanal</h2>
      <p style={{ color: 'var(--text2)', fontSize: 13, margin: '0 0 16px' }}>
        Reservas facturadas a razón social (CIF) con más de una reserva en una ventana de 6 meses — clientes recurrentes,
        buenos candidatos para una oferta temporal de precio fijo por semana.
      </p>
      <div className="table-wrap" style={{ marginBottom: 24 }}>
        <table>
          <thead><tr><th>Empresa</th><th>CIF</th><th>Reservas</th><th>Noches</th><th>Ingresos</th><th>Última estancia</th><th></th><th></th></tr></thead>
          <tbody>
            {companies.map(c => (
              <>
                <tr key={c.nif} style={{ cursor: 'pointer' }} onClick={() => setExpanded(x => x === c.nif ? null : c.nif)}>
                  <td>{c.name}</td><td>{c.nif}</td><td>{c.reservations}</td><td>{c.nights}</td>
                  <td>{fmtMoney(c.revenue)}</td><td>{c.lastStay}</td>
                  <td onClick={e => e.stopPropagation()}>
                    {c.hasOffer
                      ? <span style={{ color: 'var(--text2)', fontSize: 12 }}>Ya tiene oferta</span>
                      : <button className="btn btn-primary btn-sm" onClick={() => setModal({ name: c.name, nif: c.nif })}>Crear oferta</button>}
                  </td>
                  <td style={{ color: 'var(--text2)', fontSize: 12 }}>{expanded === c.nif ? '▾ ocultar' : '▸ ver reservas'}</td>
                </tr>
                {expanded === c.nif && (
                  <tr key={`${c.nif}-detail`}>
                    <td colSpan={8} style={{ background: 'var(--bg2)', padding: '10px 14px' }}>
                      {c.reservationList.length === 0 ? (
                        <span style={{ fontSize: 12, color: 'var(--text2)' }}>Sin reservas</span>
                      ) : (
                        <table style={{ width: '100%', fontSize: 12 }}>
                          <thead><tr>
                            <th style={{ textAlign: 'left' }}>Reserva</th><th style={{ textAlign: 'left' }}>Huésped</th>
                            <th style={{ textAlign: 'left' }}>Entrada</th><th style={{ textAlign: 'left' }}>Salida</th>
                            <th style={{ textAlign: 'left' }}>Estado</th><th style={{ textAlign: 'right' }}>Total</th>
                          </tr></thead>
                          <tbody>
                            {c.reservationList.map((r: any) => (
                              <tr key={r.id} style={{ cursor: 'pointer' }}
                                onClick={e => { e.stopPropagation(); navigate(`/reservations/${r.id}`) }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                                <td style={{ color: 'var(--accent)', fontWeight: 600 }}>#{r.id} →</td>
                                <td>{r.guestName}</td>
                                <td>{fmtDate(r.checkIn)}</td>
                                <td>{fmtDate(r.checkOut)}</td>
                                <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                                <td style={{ textAlign: 'right' }}>{fmtMoney(r.total)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
            {!loading && companies.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text2)' }}>Sin empresas candidatas todavía</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 style={{ margin: '0 0 12px' }}>Ofertas</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Empresa</th><th>Precio/semana</th><th>Vigencia</th><th>Notas</th><th>Estado</th></tr></thead>
          <tbody>
            {offers.map(o => (
              <tr key={o.id}>
                <td>{o.companyName}</td><td>{fmtMoney(parseFloat(o.weeklyPrice))}</td>
                <td>{o.validFrom} → {o.validTo}</td><td>{o.notes ?? '—'}</td>
                <td>
                  <select value={o.status} onChange={e => setStatus(o.id, e.target.value)} style={{ color: STATUS[o.status]?.color }}>
                    {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {offers.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text2)' }}>Sin ofertas todavía</td></tr>}
          </tbody>
        </table>
      </div>

      {modal && <OfferModal company={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load() }} />}
    </>
  )
}

function OfferModal({ company, onClose, onSaved }: { company: { name: string; nif: string }; onClose: () => void; onSaved: () => void }) {
  const [weeklyPrice, setWeeklyPrice] = useState('')
  const [validFrom, setValidFrom]     = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date()))
  const [validTo, setValidTo]         = useState('')
  const [notes, setNotes]             = useState('')
  const [saving, setSaving]           = useState(false)

  const save = async () => {
    const price = parseFloat(weeklyPrice)
    if (!price || price <= 0) { toast('Precio semanal inválido', 'err'); return }
    if (!validTo || validTo <= validFrom) { toast('La fecha de fin debe ser posterior a la de inicio', 'err'); return }
    setSaving(true)
    try {
      await api.createCorporateOffer({ companyName: company.name, companyNif: company.nif, weeklyPrice: price, validFrom, validTo, notes: notes || undefined })
      toast('Oferta creada'); onSaved()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={`Oferta para ${company.name}`} onClose={onClose} footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Crear oferta</button></>
    }>
      <div className="form-group"><label>Precio fijo por semana (€)</label>
        <input type="number" min="0" step="0.01" value={weeklyPrice} onChange={e => setWeeklyPrice(e.target.value)} autoFocus /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="form-group" style={{ flex: 1 }}><label>Desde</label><input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} /></div>
        <div className="form-group" style={{ flex: 1 }}><label>Hasta</label><input type="date" value={validTo} onChange={e => setValidTo(e.target.value)} /></div>
      </div>
      <div className="form-group"><label>Notas (opcional)</label>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Tipo de habitación, condiciones…" /></div>
    </Modal>
  )
}
