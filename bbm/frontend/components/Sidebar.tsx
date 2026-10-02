import { NavLink } from 'react-router-dom'
import { useProperty } from '../contexts/PropertyContext'
import { useAuth, canManage, hasRole, type AuthUser, type StaffRole } from '../contexts/AuthContext'

interface NavItem {
  to: string
  icon: string
  label: string
  allow?: (u: AuthUser | null) => boolean
}

const notLimpieza = (u: AuthUser | null) => !hasRole(u, 'limpieza')
const onlyDireccion = (u: AuthUser | null) => canManage(u)

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard',      icon: '⌂',  label: 'Inicio' },
  { to: '/planning',       icon: '▦',  label: 'Planning' },
  { to: '/arrivals',       icon: '↓',  label: 'Entradas' },
  { to: '/departures',     icon: '↑',  label: 'Salidas' },
  { to: '/housekeeping',   icon: '🧹', label: 'Housekeeping' },
  { to: '/laundry',        icon: '👕', label: 'Lavandería' },
  { to: '/id-scan',       icon: '📷',  label: 'Escaneo IDs',    allow: (u) => canManage(u) || hasRole(u, 'recepcion') },
  { to: '/reservations',   icon: '☰',  label: 'Reservas',      allow: notLimpieza },
  { to: '/guests',         icon: '👤', label: 'Huéspedes',     allow: notLimpieza },
  { to: '/billing',        icon: '€',  label: 'Facturación',   allow: onlyDireccion },
  { to: '/invoices',       icon: '🧾', label: 'Facturas',      allow: notLimpieza },
  { to: '/transactions',   icon: '⇄',  label: 'Transacciones', allow: notLimpieza },
  { to: '/cash-drawer',    icon: '💶', label: 'Caja de cambio', allow: (u) => canManage(u) || hasRole(u, 'recepcion') },
  { to: '/rates',          icon: '₯',  label: 'Tarifas',       allow: onlyDireccion },
  { to: '/rates/calendar', icon: '▦',  label: 'Precios',       allow: notLimpieza },
  { to: '/nobeds',         icon: '⇆',  label: 'Nobeds',        allow: onlyDireccion },
  { to: '/extras',         icon: '✚',   label: 'Extras',          allow: (u) => canManage(u) || hasRole(u, 'recepcion') },
  { to: '/ses',            icon: '🪪',  label: 'SES Hospedajes', allow: (u) => canManage(u) || hasRole(u, 'recepcion') },
  { to: '/notifications',  icon: '🔔', label: 'Notificaciones', allow: onlyDireccion },
  { to: '/zkteco',        icon: '🔑',  label: 'Accesos',         allow: (u) => canManage(u) || hasRole(u, 'recepcion') },
  { to: '/ai-debug',      icon: '🐛',  label: 'AI Debug',       allow: onlyDireccion },
  { to: '/rooms',          icon: '🛏',  label: 'Habitaciones' },
  { to: '/reports',        icon: '📊', label: 'Informes',       allow: notLimpieza },
  { to: '/alerts',         icon: '🚨', label: 'Alertas',        allow: onlyDireccion },
  { to: '/engagement',     icon: '📈', label: 'Implicación' },
  { to: '/users',          icon: '👥', label: 'Usuarios',        allow: onlyDireccion },
  { to: '/tenants',        icon: '🏨', label: 'Tenants',         allow: (u) => u?.isPlatformAdmin === true },
]

interface Props { open?: boolean; onClose?: () => void }

const VIEW_AS_ROLES: { value: StaffRole; label: string }[] = [
  { value: 'recepcion',     label: 'Recepción' },
  { value: 'conserje',      label: 'Conserje' },
  { value: 'mantenimiento', label: 'Mantenimiento' },
  { value: 'limpieza',      label: 'Limpieza' },
  { value: 'cocina',        label: 'Cocina' },
]

export default function Sidebar({ open, onClose }: Props) {
  const { property } = useProperty()
  const { user, realUser, viewAsRole, setViewAsRole, logout } = useAuth()

  const visible = NAV_ITEMS.filter(item => !item.allow || item.allow(user))

  return (
    <aside id="sidebar" className={open ? 'sidebar-open' : ''}>
      <div className="sidebar-logo">
        {property.name}
        <span>Booking Manager</span>
      </div>
      <nav>
        {visible.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) => isActive ? 'active' : undefined}
            onClick={onClose}
          >
            <span className="icon">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px 4px', marginTop: 'auto' }}>
        {canManage(realUser) && (
          <div style={{ marginBottom: 8 }}>
            <select
              value={viewAsRole ?? ''}
              onChange={e => setViewAsRole((e.target.value || null) as StaffRole | null)}
              title="Previsualizar la interfaz como la ve otro rol"
              style={{
                width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 6,
                border: viewAsRole ? '1px solid var(--yellow)' : '1px solid var(--border)',
                background: 'var(--bg3)', color: viewAsRole ? 'var(--yellow)' : 'var(--text2)',
                cursor: 'pointer',
              }}
            >
              <option value="">👁 Ver como… (admin)</option>
              {VIEW_AS_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {viewAsRole && (
              <button
                onClick={() => setViewAsRole(null)}
                style={{
                  width: '100%', marginTop: 4, fontSize: 11, padding: '4px 6px', borderRadius: 6,
                  border: '1px solid var(--yellow)', background: 'var(--yellow)', color: '#000',
                  fontWeight: 700, cursor: 'pointer',
                }}
              >
                ⬅ Volver a vista de administrador
              </button>
            )}
          </div>
        )}
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div className="sidebar-avatar">
              {user.avatarUrl
                ? <img src={user.avatarUrl} alt="" />
                : <span>{user.firstName[0]}{user.lastName[0]}</span>
              }
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.4, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.firstName} {user.lastName}</div>
              <div style={{ opacity: 0.7, fontSize: 11 }}>{user.roles.join(', ')}</div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <NavLink to="/settings" className={({ isActive }) => `sidebar-settings-btn${isActive ? ' active' : ''}`} title="Apariencia" style={{ flex: 1 }} onClick={onClose}>
            ⚙
          </NavLink>
          <button
            onClick={logout}
            title="Cerrar sesión"
            style={{
              flex: 1, background: 'none', border: '1px solid var(--border)', borderRadius: 6,
              cursor: 'pointer', color: 'var(--text2)', fontSize: 14, padding: '5px 0',
              transition: 'color .15s, border-color .15s',
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.color = 'var(--red)'; (e.target as HTMLElement).style.borderColor = 'var(--red)' }}
            onMouseLeave={e => { (e.target as HTMLElement).style.color = 'var(--text2)'; (e.target as HTMLElement).style.borderColor = 'var(--border)' }}
          >
            ⏻
          </button>
        </div>
      </div>
    </aside>
  )
}
