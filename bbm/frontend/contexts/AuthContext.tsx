import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

export type StaffRole = 'recepcion' | 'conserje' | 'mantenimiento' | 'direccion' | 'limpieza' | 'cocina'

export interface AuthUser {
  id: number
  email: string
  firstName: string
  lastName: string
  roles: StaffRole[]
  isPrimary?: boolean
  // Tenant (establecimiento) al que pertenece la sesión y permiso de plataforma
  propertyId?: number
  isPlatformAdmin?: boolean
  avatarUrl?: string | null
  // Fuerza AdminQuickStats como pantalla única de toda la sesión, sin sidebar
  // ni forma de cerrarla salvo cerrar sesión — ver Layout.tsx.
  simplifiedAdminMode?: boolean
}

interface AuthCtx {
  user: AuthUser | null
  // Usuario real (sin simulación de rol) — para el selector "ver como" y auditoría UI
  realUser: AuthUser | null
  // Rol simulado activo (solo admins). null = sin simulación
  viewAsRole: StaffRole | null
  setViewAsRole: (role: StaffRole | null) => void
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

const VIEW_AS_KEY = 'bm-view-as-role'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewAsRole, setViewAsRoleState] = useState<StaffRole | null>(
    () => (sessionStorage.getItem(VIEW_AS_KEY) as StaffRole) || null
  )

  const setViewAsRole = useCallback((role: StaffRole | null) => {
    setViewAsRoleState(role)
    if (role) sessionStorage.setItem(VIEW_AS_KEY, role)
    else sessionStorage.removeItem(VIEW_AS_KEY)
  }, [])

  const fetchMe = useCallback(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'include' })
    const data = await r.json()
    setUser(data.data ?? null)
  }, [])

  useEffect(() => {
    fetchMe().catch(() => setUser(null)).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const onExpired = () => setUser(null)
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error ?? 'Error al iniciar sesión')
    setUser(data.data)
  }, [])

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    setUser(null)
    // El resumen rápido de dirección (AdminQuickStats) solo se muestra una vez
    // al día — pero un cambio de sesión (cerrar y volver a entrar, quizás con
    // otro usuario) debe volver a enseñarlo, no esperar a mañana.
    try { localStorage.removeItem('admin-quickstats-seen') } catch { /* ignore */ }
  }, [])

  const refreshUser = useCallback(async () => { await fetchMe() }, [fetchMe])

  // Solo un admin real puede simular rol. El user expuesto lleva el rol simulado
  // (sin isPrimary) para que todos los canManage/hasRole del frontend reaccionen.
  const isRealAdmin   = (user?.isPrimary === true) || (user?.roles.includes('direccion') ?? false)
  const effectiveUser = user && viewAsRole && isRealAdmin
    ? { ...user, roles: [viewAsRole], isPrimary: false }
    : user

  return <Ctx.Provider value={{ user: effectiveUser, realUser: user, viewAsRole: isRealAdmin ? viewAsRole : null, setViewAsRole, loading, login, logout, refreshUser }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function hasRole(user: AuthUser | null, ...roles: StaffRole[]) {
  return user?.roles.some(r => roles.includes(r)) ?? false
}

export function canManage(user: AuthUser | null) {
  return (user?.isPrimary === true) || hasRole(user, 'direccion')
}

// Puede gestionar reservas (crear, modificar habitaciones, añadir extras, etc.)
export function canManageReservations(user: AuthUser | null) {
  return canManage(user) || hasRole(user, 'recepcion')
}
