import { useEffect, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { PropertyProvider } from './contexts/PropertyContext'
import { AuthProvider, useAuth, canManage, hasRole, type AuthUser } from './contexts/AuthContext'
import Layout from './components/Layout'
import DashboardView         from './views/DashboardView'
import PlanningView          from './views/PlanningView'
import ArrivalsView          from './views/ArrivalsView'
import DeparturesView        from './views/DeparturesView'
import BillingView           from './views/BillingView'
import RatesView             from './views/RatesView'
import PriceCalendarView     from './views/PriceCalendarView'
import ReservationsView      from './views/ReservationsView'
import ReservationDetailView from './views/ReservationDetailView'
import GuestsView            from './views/GuestsView'
import RoomsView             from './views/RoomsView'
import InvoicesView          from './views/InvoicesView'
import TransactionsView      from './views/TransactionsView'
import CashDrawerView        from './views/CashDrawerView'
import NotificationsView     from './views/NotificationsView'
import UsersView             from './views/UsersView'
import SettingsView, { applyPrefs } from './views/SettingsView'
import ReportsView           from './views/ReportsView'
import HousekeepingView      from './views/HousekeepingView'
import LiveMapView           from './views/LiveMapView'
import NobedsSyncView        from './views/NobedsSyncView'
import SesView               from './views/SesView'
import AiDebugView           from './views/AiDebugView'
import ExtrasView            from './views/ExtrasView'
import ZktecoView           from './views/ZktecoView'
import LaundryView          from './views/LaundryView'
import AlertsView            from './views/AlertsView'
import EngagementView        from './views/EngagementView'
import LoginView             from './views/LoginView'
import ResetPasswordView     from './views/ResetPasswordView'
import IdScanView            from './views/IdScanView'
import TenantsView, { ImpersonationBanner } from './views/TenantsView'

function Access({ allow, children }: { allow: (u: AuthUser | null) => boolean; children: ReactNode }) {
  const { user } = useAuth()
  return allow(user) ? <>{children}</> : <Navigate to="/dashboard" replace />
}

const notLimpieza  = (u: AuthUser | null) => !hasRole(u, 'limpieza')
const onlyDireccion = (u: AuthUser | null) => canManage(u)
const soloPlataforma = (u: AuthUser | null) => u?.isPlatformAdmin === true
const recepcionODireccion = (u: AuthUser | null) => canManage(u) || hasRole(u, 'recepcion')

function AppRoutes() {
  const { user, loading } = useAuth()

  useEffect(() => {
    if (!user) return
    fetch('/api/settings/me', { credentials: 'include' })
      .then(r => r.json())
      .then((r: any) => { if (r.data) applyPrefs(r.data) })
      .catch(() => {})
  }, [user])

  // Enlace del correo de recuperación — fuera del <Routes> normal (como
  // LoginView), accesible sin sesión y aunque YA haya una sesión activa.
  if (window.location.pathname === '/reset-password') return <ResetPasswordView />

  if (loading) return <div className="loading" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Cargando…</div>
  if (!user)   return <LoginView />

  return (
    <PropertyProvider>
      <ImpersonationBanner />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to={hasRole(user, 'limpieza') ? '/housekeeping' : '/dashboard'} replace />} />
          <Route path="dashboard"        element={<DashboardView />} />
          <Route path="planning"         element={<PlanningView />} />
          <Route path="arrivals"         element={<ArrivalsView />} />
          <Route path="departures"       element={<DeparturesView />} />
          <Route path="billing"          element={<Access allow={onlyDireccion}><BillingView /></Access>} />
          <Route path="invoices"         element={<Access allow={notLimpieza}><InvoicesView /></Access>} />
          <Route path="transactions"     element={<Access allow={notLimpieza}><TransactionsView /></Access>} />
          <Route path="cash-drawer"      element={<Access allow={recepcionODireccion}><CashDrawerView /></Access>} />
          <Route path="notifications"    element={<Access allow={onlyDireccion}><NotificationsView /></Access>} />
          <Route path="rates"            element={<Access allow={onlyDireccion}><RatesView /></Access>} />
          <Route path="rates/calendar"   element={<Access allow={notLimpieza}><PriceCalendarView /></Access>} />
          <Route path="reservations"     element={<Access allow={notLimpieza}><ReservationsView /></Access>} />
          <Route path="reservations/:id" element={<Access allow={notLimpieza}><ReservationDetailView /></Access>} />
          <Route path="guests"           element={<Access allow={notLimpieza}><GuestsView /></Access>} />
          <Route path="rooms"            element={<RoomsView />} />
          <Route path="users"            element={<Access allow={onlyDireccion}><UsersView /></Access>} />
          <Route path="settings"         element={<SettingsView />} />
          <Route path="reports"          element={<Access allow={notLimpieza}><ReportsView /></Access>} />
          <Route path="housekeeping"     element={<HousekeepingView />} />
          <Route path="live-map"         element={<LiveMapView />} />
          <Route path="nobeds"           element={<Access allow={onlyDireccion}><NobedsSyncView /></Access>} />
          <Route path="ses"              element={<Access allow={recepcionODireccion}><SesView /></Access>} />
          <Route path="id-scan"          element={<Access allow={recepcionODireccion}><IdScanView /></Access>} />
          <Route path="ai-debug"         element={<Access allow={onlyDireccion}><AiDebugView /></Access>} />
          <Route path="extras"           element={<Access allow={recepcionODireccion}><ExtrasView /></Access>} />
          <Route path="zkteco"           element={<Access allow={recepcionODireccion}><ZktecoView /></Access>} />
          <Route path="laundry"          element={<LaundryView />} />
          <Route path="alerts"           element={<Access allow={onlyDireccion}><AlertsView /></Access>} />
          <Route path="engagement"       element={<EngagementView />} />
          <Route path="tenants"          element={<Access allow={soloPlataforma}><TenantsView /></Access>} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </PropertyProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
