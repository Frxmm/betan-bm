import { useState, useEffect } from 'react'
import { toast, relativeDate } from '../lib/utils'

// ─── Caja de cambio: arqueo por denominaciones + gastos por reponer ────────────

const DENOMS: { key: string; label: string; value: number; kind: 'moneda' | 'billete' }[] = [
  { key: 'c5',   label: '5 cts',  value: 0.05, kind: 'moneda' },
  { key: 'c10',  label: '10 cts', value: 0.10, kind: 'moneda' },
  { key: 'c20',  label: '20 cts', value: 0.20, kind: 'moneda' },
  { key: 'c50',  label: '50 cts', value: 0.50, kind: 'moneda' },
  { key: 'e1',   label: '1 €',    value: 1,    kind: 'moneda' },
  { key: 'e2',   label: '2 €',    value: 2,    kind: 'moneda' },
  { key: 'b5',   label: '5 €',    value: 5,    kind: 'billete' },
  { key: 'b10',  label: '10 €',   value: 10,   kind: 'billete' },
  { key: 'b20',  label: '20 €',   value: 20,   kind: 'billete' },
  { key: 'b50',  label: '50 €',   value: 50,   kind: 'billete' },
  { key: 'b100', label: '100 €',  value: 100,  kind: 'billete' },
]

const fmt = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch('/api/cash-drawer' + path, {
    method, credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
  return d
}

export default function CashDrawerView() {
  const [counts,      setCounts]      = useState<Record<string, number>>({})
  const [floatAmount, setFloatAmount] = useState(500)
  const [expenses,    setExpenses]    = useState<any[]>([])
  const [history,     setHistory]     = useState<any[]>([])
  const [expenseHistory, setExpenseHistory] = useState<any[]>([])
  const [activeCashDeposits, setActiveCashDeposits] = useState<any[]>([])
  const [checkedDeposits, setCheckedDeposits] = useState<Set<number>>(new Set())
  const [depositCheckHistory, setDepositCheckHistory] = useState<any[]>([])
  const [historyTab,  setHistoryTab]  = useState<'arqueos' | 'gastos' | 'depositos'>('arqueos')
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState(false)
  const [checkingDeposits, setCheckingDeposits] = useState(false)
  const [expDesc,     setExpDesc]     = useState('')
  const [expAmount,   setExpAmount]   = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await req('GET', '')
      if (data.last) {
        setCounts(data.last.counts ?? {})
        setFloatAmount(parseFloat(data.last.floatAmount ?? '500'))
      }
      setExpenses(data.activeExpenses ?? [])
      setHistory(data.history ?? [])
      setExpenseHistory(data.expenseHistory ?? [])
      setActiveCashDeposits(data.activeCashDeposits ?? [])
      setDepositCheckHistory(data.depositCheckHistory ?? [])
      setCheckedDeposits(new Set())
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const totalCash     = Math.round(DENOMS.reduce((s, d) => s + d.value * (counts[d.key] ?? 0), 0) * 100) / 100
  const totalExpenses = Math.round(expenses.reduce((s, e) => s + parseFloat(e.amount), 0) * 100) / 100
  const accounted     = Math.round((totalCash + totalExpenses) * 100) / 100
  const diff          = Math.round((accounted - floatAmount) * 100) / 100

  const setCount = (key: string, v: string) => {
    const n = Math.max(0, Math.floor(Number(v) || 0))
    setCounts(prev => ({ ...prev, [key]: n }))
  }

  const saveCount = async () => {
    setSaving(true)
    try {
      await req('POST', '/count', { counts, floatAmount })
      toast('Caja guardada')
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const toggleDeposit = (id: number) => {
    setCheckedDeposits(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const confirmDepositCheck = async () => {
    setCheckingDeposits(true)
    try {
      const { data } = await req('POST', '/deposit-check', { countedIds: [...checkedDeposits] })
      if (data.ok) toast('Depósitos verificados: todo cuadra')
      else toast(`Descuadre: faltan ${data.missing.length} depósito(s) por marcar — registrado en histórico`, 'err')
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setCheckingDeposits(false) }
  }

  const addExpense = async () => {
    const amount = parseFloat(expAmount.replace(',', '.'))
    if (!expDesc.trim() || !(amount > 0)) { toast('Concepto e importe válidos requeridos', 'err'); return }
    try {
      await req('POST', '/expenses', { description: expDesc.trim(), amount })
      setExpDesc(''); setExpAmount('')
      toast('Gasto añadido')
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const removeExpense = async (id: number) => {
    if (!confirm('¿Eliminar este gasto?')) return
    try { await req('DELETE', `/expenses/${id}`); load() }
    catch (e: any) { toast(e.message, 'err') }
  }

  const replenish = async () => {
    if (!confirm(`¿Confirmar reposición? Los ${expenses.length} gastos pendientes (${fmt(totalExpenses)}) dejarán de contar — hazlo solo cuando el dinero ya esté de vuelta en la caja.`)) return
    try {
      const { data } = await req('POST', '/replenish')
      toast(`${data.replenished} gasto(s) repuestos`)
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  if (loading) return <div style={{ padding: 24 }}>Cargando caja…</div>

  const ok = Math.abs(diff) < 0.01

  return (
    <div style={{ padding: '16px 20px', maxWidth: 1100 }}>
      <h2 style={{ margin: '0 0 4px' }}>💶 Caja de cambio</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text2)' }}>
        Cuenta monedas y billetes; los gastos pendientes de reponer suman para cuadrar la consigna.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* ── Arqueo ── */}
        <div className="card" style={{ padding: 16 }}>
          {(['moneda', 'billete'] as const).map(kind => (
            <div key={kind} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                {kind === 'moneda' ? 'Monedas' : 'Billetes'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                {DENOMS.filter(d => d.kind === kind).map(d => (
                  <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 48, fontWeight: 700, fontSize: 13, textAlign: 'right' }}>{d.label}</span>
                    <input
                      type="number" min={0} step={1}
                      value={counts[d.key] ?? ''}
                      placeholder="0"
                      onChange={e => setCount(d.key, e.target.value)}
                      style={{ width: 70, textAlign: 'center' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 60 }}>
                      {fmt(d.value * (counts[d.key] ?? 0))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>EFECTIVO CONTADO</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totalCash)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>+ GASTOS SIN REPONER</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(totalExpenses)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>CONSIGNA</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="number" min={0} value={floatAmount}
                  onChange={e => setFloatAmount(Math.max(0, Number(e.target.value) || 0))}
                  style={{ width: 90, fontSize: 18, fontWeight: 700, textAlign: 'right' }} />
                <span style={{ fontWeight: 700 }}>€</span>
              </div>
            </div>
            <div style={{
              padding: '8px 16px', borderRadius: 10, fontWeight: 800, fontSize: 16,
              background: ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
              color: ok ? 'var(--green)' : 'var(--red)',
            }}>
              {ok ? '✓ Cuadra' : `${diff > 0 ? 'Sobran' : 'Faltan'} ${fmt(Math.abs(diff))}`}
            </div>
            <button className="btn btn-primary" onClick={saveCount} disabled={saving} style={{ marginLeft: 'auto' }}>
              {saving ? 'Guardando…' : '💾 Guardar caja'}
            </button>
          </div>
        </div>

        {/* ── Gastos ── */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Gastos por reponer</h3>
            {expenses.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={replenish}>↻ Reponer todo</button>
            )}
          </div>

          {expenses.length === 0 && <p style={{ fontSize: 13, color: 'var(--text2)' }}>Sin gastos pendientes.</p>}
          {expenses.map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <span style={{ flex: 1 }}>{e.description}</span>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>{new Date(e.createdAt).toLocaleDateString('es-ES')}</span>
              <strong>{fmt(parseFloat(e.amount))}</strong>
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => removeExpense(e.id)}>✕</button>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <input placeholder="Concepto (p.ej. pilas mando)" value={expDesc}
              onChange={e => setExpDesc(e.target.value)} style={{ flex: 1 }} />
            <input placeholder="€" value={expAmount} inputMode="decimal"
              onChange={e => setExpAmount(e.target.value)} style={{ width: 70 }} />
            <button className="btn btn-ghost" onClick={addExpense}>+ Añadir</button>
          </div>
        </div>
      </div>

      {/* ── Depósitos en efectivo: verificación manual ── */}
      <div className="card" style={{ padding: 16, marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Depósitos en efectivo — verificación</h3>
          {activeCashDeposits.length > 0 && (
            <button className="btn btn-primary btn-sm" onClick={confirmDepositCheck} disabled={checkingDeposits}>
              {checkingDeposits ? 'Comprobando…' : `✓ Confirmar recuento (${checkedDeposits.size}/${activeCashDeposits.length})`}
            </button>
          )}
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text2)' }}>
          Marca cada depósito que hayas contado físicamente en la caja. Si al confirmar queda alguno sin marcar,
          se registra la discrepancia en el histórico de abajo.
        </p>

        {activeCashDeposits.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text2)' }}>Sin depósitos en efectivo activos (reservas en casa).</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
            {activeCashDeposits.map((d: any) => {
              const on = checkedDeposits.has(d.id)
              return (
                <label key={d.id} style={{
                  display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 8,
                  border: `1px solid ${on ? 'var(--green)' : 'var(--border)'}`,
                  background: on ? 'rgba(34,197,94,.10)' : 'transparent',
                  cursor: 'pointer', fontSize: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={on} onChange={() => toggleDeposit(d.id)} />
                    <strong style={{ fontSize: 13 }}>{fmt(parseFloat(d.amount))}</strong>
                  </div>
                  <span style={{ color: 'var(--text2)' }}>{d.guestName}</span>
                  <span style={{ color: 'var(--text2)' }}>Hab. {d.roomCode ?? '—'}</span>
                  <span style={{ color: 'var(--text2)' }}>Salida: {relativeDate(d.checkOutDate)}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Histórico ── */}
      <div className="card" style={{ padding: 16, marginTop: 20 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          <button
            className={`btn btn-sm ${historyTab === 'arqueos' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setHistoryTab('arqueos')}
          >Últimos arqueos</button>
          <button
            className={`btn btn-sm ${historyTab === 'gastos' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setHistoryTab('gastos')}
          >Histórico de gastos</button>
          <button
            className={`btn btn-sm ${historyTab === 'depositos' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setHistoryTab('depositos')}
          >Descuadres de depósitos</button>
        </div>

        {historyTab === 'arqueos' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr><th>Fecha y hora</th><th>Usuario</th><th style={{ textAlign: 'right' }}>Efectivo</th><th style={{ textAlign: 'right' }}>Consigna</th></tr>
              </thead>
              <tbody>
                {history.map((h: any) => (
                  <tr key={h.id}>
                    <td>{new Date(h.counted_at).toLocaleString('es-ES')}</td>
                    <td>{h.counted_by_name}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(parseFloat(h.total_cash))}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text2)' }}>{fmt(parseFloat(h.float_amount))}</td>
                  </tr>
                ))}
                {history.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--text2)' }}>Sin arqueos todavía.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {historyTab === 'gastos' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Añadido</th><th>Concepto</th><th style={{ textAlign: 'right' }}>Importe</th>
                  <th>Añadido por</th><th>Repuesto</th><th>Repuesto por</th>
                </tr>
              </thead>
              <tbody>
                {expenseHistory.map((e: any) => (
                  <tr key={e.id}>
                    <td>{new Date(e.created_at).toLocaleString('es-ES')}</td>
                    <td>{e.description}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(parseFloat(e.amount))}</td>
                    <td>{e.created_by_name}</td>
                    <td style={{ color: e.replenished_at ? 'var(--text2)' : 'var(--red)' }}>
                      {e.replenished_at ? new Date(e.replenished_at).toLocaleString('es-ES') : 'Pendiente'}
                    </td>
                    <td>{e.replenished_by_name ?? '—'}</td>
                  </tr>
                ))}
                {expenseHistory.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text2)' }}>Sin gastos todavía.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {historyTab === 'depositos' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Fecha y hora</th><th>Verificado por</th>
                  <th style={{ textAlign: 'right' }}>Activos en sistema</th>
                  <th style={{ textAlign: 'right' }}>Contabilizados</th>
                  <th style={{ textAlign: 'right' }}>Faltan</th>
                </tr>
              </thead>
              <tbody>
                {depositCheckHistory.map((d: any) => (
                  <tr key={d.id}>
                    <td>{new Date(d.checked_at).toLocaleString('es-ES')}</td>
                    <td>{d.checked_by_name}</td>
                    <td style={{ textAlign: 'right' }}>{d.system_count}</td>
                    <td style={{ textAlign: 'right' }}>{d.counted_count}</td>
                    <td style={{ textAlign: 'right', color: 'var(--red)', fontWeight: 700 }}>{d.system_count - d.counted_count}</td>
                  </tr>
                ))}
                {depositCheckHistory.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--text2)' }}>Sin descuadres registrados.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
