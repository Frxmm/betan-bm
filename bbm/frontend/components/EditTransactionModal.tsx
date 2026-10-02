import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { toast, accountsForMethod } from '../lib/utils'
import { Modal } from './Modal'

export function EditTransactionModal({ tx, accounts, onClose, onSaved }: {
  tx: any
  accounts: any[]
  onClose: () => void
  onSaved: () => void
}) {
  const [accountId, setAccountId] = useState(String(tx.financialAccountId ?? ''))
  const [method,    setMethod]    = useState(tx.paymentMethod ?? '')
  const [amount,    setAmount]    = useState(String(tx.amount ?? ''))
  const [methods,   setMethods]   = useState<any[]>([])
  const [saving,    setSaving]    = useState(false)

  useEffect(() => {
    api.listPaymentMethods().then((r: any) => setMethods(r.data ?? [])).catch(() => {})
  }, [])

  const visibleAccounts = method ? accountsForMethod(accounts, method) : accounts
  useEffect(() => {
    if (accountId && !visibleAccounts.some((a: any) => String(a.id) === accountId)) setAccountId('')
  }, [method])

  const save = async () => {
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount === 0) { toast('Importe inválido', 'err'); return }
    setSaving(true)
    try {
      await api.updateTransaction(tx.id, {
        financialAccountId: accountId ? Number(accountId) : undefined,
        paymentMethod:      method || undefined,
        amount:             parsedAmount,
      })
      toast('Transacción actualizada')
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={`Editar transacción #${tx.id}`} onClose={onClose} footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button>
      </>
    }>
      <div className="form-grid">
        <div className="form-group full">
          <label>Importe (€)</label>
          <input type="number" step="0.01" value={amount}
            onChange={e => setAmount(e.target.value)} autoFocus />
        </div>
        <div className="form-group">
          <label>Caja</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">Sin caja</option>
            {visibleAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Forma de pago</label>
          <select value={method} onChange={e => setMethod(e.target.value)}>
            <option value="">Sin especificar</option>
            {methods.filter((m: any) => m.active).map((m: any) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  )
}
