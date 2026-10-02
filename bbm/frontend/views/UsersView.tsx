import { useState, useEffect, useCallback } from 'react'
import { Modal } from '../components/Modal'
import { toast } from '../lib/utils'
import { useAuth, canManage, type StaffRole } from '../contexts/AuthContext'

const ALL_ROLES: { id: StaffRole; label: string }[] = [
  { id: 'recepcion',     label: 'Recepción' },
  { id: 'conserje',      label: 'Conserje' },
  { id: 'mantenimiento', label: 'Mantenimiento' },
  { id: 'direccion',     label: 'Dirección' },
  { id: 'limpieza',      label: 'Limpieza' },
  { id: 'cocina',        label: 'Cocina' },
]

function roleBadge(role: StaffRole) {
  const colors: Record<StaffRole, string> = {
    recepcion:     '#4f7cff',
    conserje:      '#06b6d4',
    mantenimiento: '#f59e0b',
    direccion:     '#a855f7',
    limpieza:      '#22c55e',
    cocina:        '#f97316',
  }
  const labels: Record<StaffRole, string> = {
    recepcion: 'Recepción', conserje: 'Conserje', mantenimiento: 'Mantenimiento',
    direccion: 'Dirección', limpieza: 'Limpieza', cocina: 'Cocina',
  }
  return (
    <span key={role} style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600,
      background: colors[role] + '22', color: colors[role],
      border: `1px solid ${colors[role]}55`,
      borderRadius: 6, padding: '1px 7px', marginRight: 4,
    }}>
      {labels[role]}
    </span>
  )
}

export default function UsersView() {
  const { user } = useAuth()
  const admin = canManage(user)

  const [users,   setUsers]   = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/users', { credentials: 'include' })
      const data = await r.json()
      setUsers(data.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const deactivate = async (u: any) => {
    if (!confirm(`¿Desactivar la cuenta de ${u.firstName} ${u.lastName}?`)) return
    try {
      await fetch(`/api/users/${u.id}`, { method: 'DELETE', credentials: 'include' })
      toast(`Cuenta de ${u.firstName} desactivada`)
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const sendPasswordReset = async (u: any) => {
    if (!confirm(`¿Enviar correo de recuperación de contraseña a ${u.firstName} ${u.lastName} (${u.email})?`)) return
    try {
      const r = await fetch(`/api/users/${u.id}/send-password-reset`, { method: 'POST', credentials: 'include' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Error al enviar el correo')
      toast(`Correo de recuperación enviado a ${u.firstName}`)
    } catch (e: any) { toast(e.message, 'err') }
  }

  const visible = showInactive ? users : users.filter(u => u.active)

  if (!admin) return (
    <div className="empty">
      <div className="icon">🔒</div>
      <p>Acceso restringido a Dirección y administradores</p>
    </div>
  )

  if (loading) return <div className="loading">Cargando…</div>
  if (error)   return <div className="empty"><p style={{ color: 'var(--red)' }}>{error}</p></div>

  return (
    <>
      <div className="view-header">
        <div>
          <h2>Usuarios</h2>
          <p className="view-subtitle">Personal con acceso al sistema</p>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Mostrar desactivados
        </label>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Nuevo usuario</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>DNI</th>
              <th>Teléfono</th>
              <th>Roles</th>
              <th>Estado</th>
              <th>Último acceso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u: any) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td>
                  <strong>{u.firstName} {u.lastName}</strong>
                  {u.isPrimary && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>ADMIN</span>}
                </td>
                <td style={{ fontSize: 13, color: 'var(--text2)' }}>{u.email}</td>
                <td style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'monospace' }}>{u.dni ?? '—'}</td>
                <td style={{ fontSize: 12, color: 'var(--text2)' }}>{u.phone ?? '—'}</td>
                <td>{(u.roles as StaffRole[]).map(roleBadge)}</td>
                <td>
                  <span style={{ fontSize: 12, color: u.active ? 'var(--green)' : 'var(--text2)' }}>
                    {u.active ? '● Activo' : '○ Inactivo'}
                  </span>
                </td>
                <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost btn-xs" onClick={() => setEditing(u)}>Editar</button>
                  {u.active && (
                    <button className="btn btn-ghost btn-xs" style={{ marginLeft: 4 }} onClick={() => sendPasswordReset(u)} title="Enviar correo de recuperación de contraseña">
                      Recuperar contraseña
                    </button>
                  )}
                  {u.active && (
                    <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)', marginLeft: 4 }} onClick={() => deactivate(u)}>
                      Desactivar
                    </button>
                  )}
                  {!u.active && (
                    <button className="btn btn-ghost btn-xs" style={{ color: 'var(--green)', marginLeft: 4 }} onClick={async () => {
                      await fetch(`/api/users/${u.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }) })
                      toast(`${u.firstName} reactivado`); load()
                    }}>
                      Reactivar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="empty" style={{ padding: 24 }}><p>Sin usuarios</p></div>
        )}
      </div>

      {editing !== null && (
        <UserModal
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </>
  )
}

function UserModal({ user, onClose, onSaved }: { user: any | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !user
  const [form, setForm] = useState({
    firstName: user?.firstName ?? '',
    lastName:  user?.lastName  ?? '',
    email:     user?.email     ?? '',
    password:  '',
    dni:       user?.dni   ?? '',
    phone:     user?.phone ?? '',
    active:    user?.active !== false,
    roles:     (user?.roles ?? []) as StaffRole[],
    simplifiedAdminMode: user?.simplifiedAdminMode ?? false,
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const chk = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.checked }))

  const toggleRole = (role: StaffRole) =>
    setForm(f => ({
      ...f,
      roles: f.roles.includes(role) ? f.roles.filter(r => r !== role) : [...f.roles, role],
    }))

  const save = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) { toast('Nombre y apellido obligatorios', 'err'); return }
    if (!form.email.trim()) { toast('El email es obligatorio', 'err'); return }
    if (isNew && !form.password) { toast('La contraseña es obligatoria para nuevos usuarios', 'err'); return }
    if (form.roles.length === 0) { toast('Asigna al menos un rol', 'err'); return }
    setSaving(true)
    try {
      const body: any = {
        firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        email: form.email.trim(), roles: form.roles,
        active: form.active,
        dni:   form.dni.trim()   || null,
        phone: form.phone.trim() || null,
        simplifiedAdminMode: form.simplifiedAdminMode,
      }
      if (form.password) body.password = form.password
      const url    = isNew ? '/api/users' : `/api/users/${user.id}`
      const method = isNew ? 'POST' : 'PATCH'
      const r = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? 'Error al guardar')
      toast(isNew ? 'Usuario creado' : 'Usuario actualizado')
      onSaved()
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={isNew ? 'Nuevo usuario' : `Editar: ${user.firstName} ${user.lastName}`} onClose={onClose} wide footer={
      <><button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>Guardar</button></>
    }>
      <div className="form-grid">
        <div className="form-group">
          <label>Nombre *</label>
          <input value={form.firstName} onChange={set('firstName')} placeholder="María" />
        </div>
        <div className="form-group">
          <label>Apellidos *</label>
          <input value={form.lastName} onChange={set('lastName')} placeholder="García López" />
        </div>
        <div className="form-group">
          <label>Email *</label>
          <input type="email" value={form.email} onChange={set('email')} placeholder="maria@hotel.es" />
        </div>
        <div className="form-group">
          <label>{isNew ? 'Contraseña *' : 'Nueva contraseña (vacío = no cambiar)'}</label>
          <input type="password" value={form.password} onChange={set('password')} placeholder="••••••••" autoComplete="new-password" />
        </div>
        <div className="form-group">
          <label>DNI / NIE</label>
          <input value={form.dni} onChange={set('dni')} placeholder="12345678A" />
        </div>
        <div className="form-group">
          <label>Teléfono</label>
          <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+34 600 000 000" />
        </div>
      </div>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>Roles *</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {ALL_ROLES.map(({ id, label }) => (
            <label key={id} style={{
              display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontSize: 13, padding: '5px 12px', borderRadius: 6, userSelect: 'none',
              background: form.roles.includes(id) ? 'rgba(79,124,255,.15)' : 'var(--bg3)',
              border: `1px solid ${form.roles.includes(id) ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: form.roles.includes(id) ? 600 : 400,
            }}>
              <input type="checkbox" checked={form.roles.includes(id)} onChange={() => toggleRole(id)} style={{ margin: 0 }} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={form.active} onChange={chk('active')} />
          Cuenta activa
        </label>
      </div>

      {form.roles.includes('direccion') && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <input type="checkbox" checked={form.simplifiedAdminMode} onChange={chk('simplifiedAdminMode')} />
            Modo admin simplificado
          </label>
          <p style={{ fontSize: 12, color: 'var(--text2)', margin: '4px 0 0 22px' }}>
            Al iniciar sesión, este usuario verá únicamente el Resumen rápido a pantalla completa
            durante toda la sesión — sin menú ni resto de la app. Solo puede salir cerrando sesión.
          </p>
        </div>
      )}
    </Modal>
  )
}
