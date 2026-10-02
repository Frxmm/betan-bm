import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { fmtMoney, toast } from '../lib/utils'
import { useAuth, canManage } from '../contexts/AuthContext'
import { useProperty } from '../contexts/PropertyContext'
import {
  DEFAULT_INVOICE_TEMPLATE,
  buildItemsTable,
  renderTemplate,
  printInvoice,
  brandingData,
} from '../lib/invoicePrint'
import { EditInvoiceModal } from './ReservationDetailView'

function firstOfYear() { return `${new Date().getFullYear()}-01-01` }
function todayISO()    { return new Date().toISOString().slice(0, 10) }

// Objeto de muestra para generar la tabla de partidas del preview
const SAMPLE_INV = {
  subtotal:    '168.18',  // 185 / 1.10
  taxAmount:   '16.82',
  total:       '185.00',
  reservation: { nights: 4, rate: { title: 'Tarifa estándar' } },
}

// Variables de plantilla disponibles para previsualización
// buildItemsTable está definida más abajo pero las function declarations son hoisted
const SAMPLE_DATA: Record<string, string> = {
  '{{invoiceNumber}}':   '0000001/2026',
  '{{date}}':            '29/06/2026',
  '{{guestFirstName}}':  'Juan',
  '{{guestLastName}}':   'García López',
  '{{guestCompany}}':    '',
  '{{guestAddress1}}':   'Calle Mayor 10, 2ºA',
  '{{guestAddress2}}':   '',
  '{{guestCity}}':       'Málaga',
  '{{guestPostalCode}}': '29001',
  '{{guestCountry}}':    'España',
  '{{guestNif}}':        '12345678Z',
  '{{reservationCode}}': 'BK-00123',
  '{{checkIn}}':         '01/07/2026',
  '{{checkOut}}':        '05/07/2026',
  '{{nights}}':          '4',
  '{{pax}}':             '2',
  '{{rate}}':            'Tarifa estándar',
  '{{subtotal}}':        '168,18',
  '{{taxAmount}}':       '16,82',
  '{{total}}':           '185,00',
  '{{paymentMethod}}':   'Tarjeta',
  '{{notes}}':           '',
  get '{{itemsTable}}'() { return buildItemsTable(SAMPLE_INV) },
}

const DEFAULT_TEMPLATE = DEFAULT_INVOICE_TEMPLATE

// ─── Pestaña Configuración (admin) ────────────────────────────────────────────

function InvoiceConfigTab() {
  const { property } = useProperty()
  const [format,  setFormat]  = useState('{N:7}/{YYYY}')
  const [nextNum, setNextNum] = useState(1)
  const [taxRate, setTaxRate] = useState(10)
  const [tpl,     setTpl]     = useState(DEFAULT_TEMPLATE)
  const [saving,  setSaving]  = useState(false)
  const [preview, setPreview] = useState('')

  useEffect(() => {
    fetch('/api/financial/invoice-config', { credentials: 'include' })
      .then(r => r.json()).then((r: any) => {
        if (r.data) {
          setFormat(r.data.numberFormat)
          setNextNum(r.data.nextNumber)
          setTaxRate(parseFloat(r.data.taxRate ?? '10'))
          setTpl(r.data.htmlTemplate ?? DEFAULT_TEMPLATE)
        }
      }).catch(() => {})
  }, [])

  useEffect(() => {
    const year = new Date().getFullYear()
    const out = format
      .replace('{YYYY}', String(year))
      .replace('{YY}',   String(year).slice(-2))
      .replace(/\{N(?::(\d+))?\}/g, (_: string, pad: string) =>
        pad ? String(nextNum).padStart(Number(pad), '0') : String(nextNum)
      )
    setPreview(out)
  }, [format, nextNum])

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch('/api/financial/invoice-config', {
        method:  'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ numberFormat: format, nextNumber: nextNum, taxRate, htmlTemplate: tpl }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Error')
      toast('Configuración guardada')
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const tplRendered = renderTemplate(tpl, { ...SAMPLE_DATA, ...brandingData(property) })

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>

      {/* Columna izquierda: formulario */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Formato numeración + IVA */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>Formato de numeración</div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label>Patrón</label>
            <input
              value={format}
              onChange={e => setFormat(e.target.value)}
              style={{ fontFamily: 'monospace' }}
              placeholder="{N:7}/{YYYY}"
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12, lineHeight: 1.6 }}>
            <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{YYYY}'}</code> año completo &nbsp;
            <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{YY}'}</code> año corto &nbsp;
            <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{N:4}'}</code> número con relleno
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg3)', borderRadius: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Siguiente factura:</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--accent2)', fontSize: 15 }}>{preview}</span>
          </div>

          <div className="form-group" style={{ marginTop: 14 }}>
            <label>Siguiente número de secuencia</label>
            <input
              type="number"
              min="1"
              value={nextNum}
              onChange={e => setNextNum(Math.max(1, Number(e.target.value)))}
              style={{ width: 120 }}
            />
            <span style={{ fontSize: 11, color: 'var(--text2)', display: 'block', marginTop: 3 }}>
              El número real usado será el mayor entre éste y el último registrado en BD + 1.
            </span>
          </div>

          <div className="form-group" style={{ marginTop: 14 }}>
            <label>IVA (%)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={taxRate}
                onChange={e => setTaxRate(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                style={{ width: 90 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                El IVA se desglosará al crear la factura desde reserva (precio incluye IVA).
              </span>
            </div>
          </div>
        </div>

        {/* Variables disponibles */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Variables de plantilla</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {Object.entries(SAMPLE_DATA).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 3, color: 'var(--accent)', fontWeight: 600, minWidth: 180 }}>{k}</code>
                <span style={{ color: 'var(--text2)' }}>{v || '(vacío si no aplica)'}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text2)' }}>
            Bloques condicionales: <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{{#reservation}}...{{/reservation}}'}</code>
            <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3, marginLeft: 6 }}>{'{{#tax}}...{{/tax}}'}</code>
            <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3, marginLeft: 6 }}>{'{{#notes}}...{{/notes}}'}</code>
          </div>
        </div>

        <button className="btn btn-primary" onClick={save} disabled={saving} style={{ alignSelf: 'flex-start' }}>
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </button>
      </div>

      {/* Columna derecha: editor + preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>Plantilla HTML</div>
          <textarea
            value={tpl}
            onChange={e => setTpl(e.target.value)}
            rows={22}
            style={{
              width: '100%', fontFamily: 'monospace', fontSize: 11,
              background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 6, padding: 10, color: 'var(--text)', resize: 'vertical',
              lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setTpl(DEFAULT_TEMPLATE)}>
              Restaurar plantilla por defecto
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            Preview
            <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>(datos de muestra)</span>
          </div>
          <iframe
            srcDoc={tplRendered}
            sandbox="allow-same-origin"
            style={{
              width: '100%', height: 380, border: '1px solid var(--border)',
              borderRadius: 6, background: '#fff',
            }}
            title="Invoice preview"
          />
        </div>
      </div>
    </div>
  )
}

// ─── Vista principal ───────────────────────────────────────────────────────────

export default function InvoicesView() {
  const { property } = useProperty()
  const navigate = useNavigate()
  const { user } = useAuth()
  const admin = canManage(user)

  const [activeTab, setActiveTab] = useState<'list' | 'config'>('list')

  const [invoiceTemplate, setInvoiceTemplate] = useState<string | null>(null)

  const [dateFrom,  setDateFrom]  = useState(firstOfYear())
  const [dateTo,    setDateTo]    = useState(todayISO())
  const [numFilter, setNumFilter] = useState('')
  const [page,      setPage]      = useState(1)
  const [sortBy,    setSortBy]    = useState<'invoiceNumber' | 'issuedAt' | 'subtotal' | 'total'>('invoiceNumber')
  const [sortDir,   setSortDir]   = useState<'asc' | 'desc'>('desc')
  const [data,           setData]           = useState<any[]>([])
  const [meta,           setMeta]           = useState<any>(null)
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [editingInvoice, setEditingInvoice] = useState<any>(null)

  const numDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch('/api/financial/invoice-config', { credentials: 'include' })
      .then(r => r.json())
      .then((r: any) => { if (r.data?.htmlTemplate) setInvoiceTemplate(r.data.htmlTemplate) })
      .catch(() => {})
  }, [])

  const load = useCallback(async (
    p: number, from: string, to: string, num: string,
    sb: string, sd: string,
  ) => {
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { page: String(p), limit: '50', sortBy: sb, sortDir: sd }
      if (from) params.dateFrom = from
      if (to)   params.dateTo   = to
      if (num)  params.invoiceNumber = num
      const res: any = await api.listInvoices(params)
      setData(res.data); setMeta(res.meta ?? null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(1, dateFrom, dateTo, numFilter, sortBy, sortDir) }, []) // eslint-disable-line

  const apply = () => { setPage(1); load(1, dateFrom, dateTo, numFilter, sortBy, sortDir) }

  const toggleSort = (col: typeof sortBy) => {
    const newDir = sortBy === col && sortDir === 'desc' ? 'asc' : 'desc'
    const newCol = col
    setSortBy(newCol); setSortDir(newDir); setPage(1)
    load(1, dateFrom, dateTo, numFilter, newCol, newDir)
  }

  const SortTh = ({ col, label, align }: { col: typeof sortBy; label: string; align?: string }) => (
    <th
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: align as any, whiteSpace: 'nowrap' }}
      onClick={() => toggleSort(col)}
    >
      {label}{' '}
      <span style={{ opacity: sortBy === col ? 1 : 0.25, fontSize: 11 }}>
        {sortBy === col ? (sortDir === 'desc' ? '↓' : '↑') : '↕'}
      </span>
    </th>
  )

  const deleteInvoice = async (inv: any) => {
    if (!confirm(`¿Eliminar la factura ${inv.invoiceNumber}? Esta acción no se puede deshacer.`)) return
    try {
      const r = await fetch(`/api/financial/invoices/${inv.id}`, { method: 'DELETE', credentials: 'include' })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Error')
      toast(`Factura ${inv.invoiceNumber} eliminada`)
      load(page, dateFrom, dateTo, numFilter, sortBy, sortDir)
    } catch (e: any) { toast(e.message, 'err') }
  }

  const handleNumChange = (v: string) => {
    setNumFilter(v)
    if (numDebounce.current) clearTimeout(numDebounce.current)
    numDebounce.current = setTimeout(() => { setPage(1); load(1, dateFrom, dateTo, v, sortBy, sortDir) }, 350)
  }

  const totalShown = data.reduce((s, inv) => s + parseFloat(inv.total ?? '0'), 0)

  const exportExcel = async () => {
    try {
      const params: Record<string, string> = { page: '1', limit: '9999', sortBy, sortDir }
      if (dateFrom)   params.dateFrom      = dateFrom
      if (dateTo)     params.dateTo        = dateTo
      if (numFilter)  params.invoiceNumber = numFilter
      const res: any = await api.listInvoices(params)
      const rows: any[] = res.data

      const esc = (v: any) => {
        const s = String(v ?? '')
        return s.includes(';') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
      }

      const headers = ['Nº Factura', 'Fecha', 'Razón social', 'NIF', 'Huésped', 'Canal', 'Reserva', 'Check-in', 'Check-out', 'Base imponible', 'IVA', 'Total', 'Notas']
      const lines = [headers.join(';')]
      for (const inv of rows) {
        const razonSocial = inv.billingName ?? ''
        const huesped = inv.guest ? `${inv.guest.firstName} ${inv.guest.lastName}`.trim() : ''
        lines.push([
          inv.invoiceNumber,
          inv.issuedAt,
          razonSocial,
          inv.billingNif ?? '',
          huesped,
          inv.reservation?.bookingChannel?.name ?? '',
          inv.reservation ? (inv.reservation.externalCode ?? `#${inv.reservation.id}`) : '',
          inv.reservation?.checkInDate  ?? '',
          inv.reservation?.checkOutDate ?? '',
          String(parseFloat(inv.subtotal ?? '0').toFixed(2)).replace('.', ','),
          String(parseFloat(inv.taxAmount ?? '0').toFixed(2)).replace('.', ','),
          String(parseFloat(inv.total ?? '0').toFixed(2)).replace('.', ','),
          inv.notes ?? '',
        ].map(esc).join(';'))
      }

      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `facturas_${dateFrom}_${dateTo}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) { toast(e.message, 'err') }
  }

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Facturas</h2>
          <p className="view-subtitle">Listado y configuración de facturas emitidas</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', alignSelf: 'flex-start' }}>
          {([
            { id: 'list',   label: 'Listado' },
            { id: 'config', label: 'Configuración', adminOnly: true },
          ] as { id: 'list' | 'config'; label: string; adminOnly?: boolean }[]).map(t => {
            const disabled = t.adminOnly && !admin
            return (
              <button
                key={t.id}
                disabled={disabled}
                onClick={() => !disabled && setActiveTab(t.id)}
                style={{
                  padding: '7px 16px', fontSize: 13, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
                  fontWeight: activeTab === t.id ? 600 : 400,
                  background: activeTab === t.id ? 'var(--accent)' : 'transparent',
                  color: disabled ? 'var(--text3)' : activeTab === t.id ? '#fff' : 'var(--text2)',
                  transition: 'background .15s, color .15s',
                }}
                title={disabled ? 'Solo administradores' : undefined}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Tab: Listado ── */}
      {activeTab === 'list' && (
        <>
          <div className="search-bar">
            <input
              placeholder="Número de factura…"
              type="search"
              value={numFilter}
              onChange={e => handleNumChange(e.target.value)}
              style={{ minWidth: 180 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>Del</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ width: 145 }} />
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>al</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ width: 145 }} />
            <button className="btn btn-ghost btn-sm" onClick={apply}>Aplicar</button>
          </div>

          {loading && <div className="loading">Cargando…</div>}
          {error   && <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>}

          {!loading && !error && (
            data.length === 0
              ? <div className="empty"><div className="icon">🧾</div><p>Sin facturas en el período</p></div>
              : (
                <div className="card">
                  <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2>
                      Facturas
                      <span style={{ color: 'var(--text2)', fontWeight: 400, marginLeft: 6 }}>
                        ({meta?.total ?? data.length})
                      </span>
                    </h2>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 13, color: 'var(--text2)' }}>
                        Total mostrado: <strong style={{ color: 'var(--text)' }}>{fmtMoney(totalShown)}</strong>
                      </span>
                      <button className="btn btn-ghost btn-sm" onClick={exportExcel}>⬇ Exportar Excel</button>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <SortTh col="invoiceNumber" label="Nº Factura" />
                          <SortTh col="issuedAt"      label="Fecha" />
                          <th>Razón social</th>
                          <th>Huésped</th>
                          <th>Canal</th>
                          <th>Reserva</th>
                          <SortTh col="subtotal" label="Base"  align="right" />
                          <th style={{ textAlign: 'right' }}>IVA</th>
                          <SortTh col="total"    label="Total" align="right" />
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.map((inv: any) => (
                          <tr key={inv.id}>
                            <td>
                              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent2)' }}>
                                {inv.invoiceNumber}
                              </span>
                            </td>
                            <td style={{ fontSize: 12, color: 'var(--text2)' }}>{inv.issuedAt}</td>
                            <td style={{ fontSize: 13 }}>
                              {inv.billingName
                                ? <><strong>{inv.billingName}</strong>{inv.billingNif && <span style={{ color: 'var(--text2)', marginLeft: 5, fontSize: 12 }}>{inv.billingNif}</span>}</>
                                : <span style={{ color: 'var(--text2)' }}>—</span>}
                            </td>
                            <td style={{ fontSize: 13 }}>
                              {inv.guest
                                ? `${inv.guest.firstName} ${inv.guest.lastName}`
                                : <span style={{ color: 'var(--text2)' }}>—</span>}
                            </td>
                            <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                              {inv.reservation?.bookingChannel?.name ?? <span style={{ color: 'var(--text2)' }}>—</span>}
                            </td>
                            <td>
                              {inv.reservation
                                ? (
                                  <a href="#" style={{ fontSize: 12 }}
                                    onClick={e => { e.preventDefault(); navigate(`/reservations/${inv.reservation.id}`) }}>
                                    {inv.reservation.externalCode ?? `#${inv.reservation.id}`}
                                  </a>
                                )
                                : <span style={{ color: 'var(--text2)', fontSize: 12 }}>—</span>}
                            </td>
                            <td style={{ textAlign: 'right' }}>{fmtMoney(parseFloat(inv.subtotal))}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text2)', fontSize: 12 }}>
                              {parseFloat(inv.taxAmount) > 0 ? fmtMoney(parseFloat(inv.taxAmount)) : '—'}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(parseFloat(inv.total))}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="btn btn-ghost btn-xs"
                                onClick={() => printInvoice(inv, invoiceTemplate, property)}>
                                Imprimir
                              </button>
                              {admin && (
                                <button className="btn btn-ghost btn-xs"
                                  style={{ marginLeft: 4 }}
                                  onClick={() => setEditingInvoice(inv)}>
                                  Editar
                                </button>
                              )}
                              {admin && (
                                <button className="btn btn-ghost btn-xs"
                                  style={{ color: 'var(--red)', marginLeft: 4 }}
                                  onClick={() => deleteInvoice(inv)}>
                                  Eliminar
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {meta && meta.total > 50 && (
                    <div style={{ padding: '12px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border)' }}>
                      <button className="btn btn-ghost btn-sm" disabled={page === 1}
                        onClick={() => { const p = page - 1; setPage(p); load(p, dateFrom, dateTo, numFilter, sortBy, sortDir) }}>
                        ← Anterior
                      </button>
                      <span style={{ padding: '4px 8px', color: 'var(--text2)', fontSize: 13 }}>
                        Página {page} de {Math.ceil(meta.total / 50)}
                      </span>
                      <button className="btn btn-ghost btn-sm"
                        disabled={page >= Math.ceil(meta.total / 50)}
                        onClick={() => { const p = page + 1; setPage(p); load(p, dateFrom, dateTo, numFilter, sortBy, sortDir) }}>
                        Siguiente →
                      </button>
                    </div>
                  )}
                </div>
              )
          )}
        </>
      )}

      {/* ── Tab: Configuración (admin) ── */}
      {activeTab === 'config' && admin && <InvoiceConfigTab />}

      {editingInvoice && (
        <EditInvoiceModal
          invoice={editingInvoice}
          onClose={() => setEditingInvoice(null)}
          onSaved={(updated) => {
            setData(prev => prev.map(inv => inv.id === updated.id ? { ...inv, ...updated } : inv))
            setEditingInvoice(null)
          }}
        />
      )}
    </>
  )
}
