import { useState, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import UrgentAlertsBar from './UrgentAlertsBar'
import EngagementWeeklyPopup from './EngagementWeeklyPopup'
import ImportantStaffMessagePopup from './ImportantStaffMessagePopup'
import DailyReceptionReminderPopup from './DailyReceptionReminderPopup'
import BreakfastLockGuard from './BreakfastLockGuard'
import AdminQuickStats, { AdminQuickStatsModal } from './AdminQuickStats'
import { useAuth } from '../contexts/AuthContext'

export default function Layout() {
  const { user } = useAuth()
  const [navOpen, setNavOpen]   = useState(false)
  const [bgCredit, setBgCredit] = useState('')
  const location = useLocation()

  // Cierra el drawer al cambiar de ruta
  useEffect(() => { setNavOpen(false) }, [location.pathname])

  // Fondo de pantalla elegido por el usuario en conversación con el asistente IA.
  // Se carga al entrar y se vuelve a pedir si el asistente lo cambia a media
  // sesión (evento disparado desde AgentFloat), sin necesidad de recargar.
  useEffect(() => {
    const loadBg = () => {
      fetch('/api/settings/me', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          const url = d?.data?.dashboardBgUrl
          if (!url) return
          document.documentElement.style.setProperty('--dashboard-bg-url', `url(${url})`)
          document.body.classList.add('has-dashboard-bg')
          setBgCredit(d.data.dashboardBgCredit ?? '')
        })
        .catch(() => {})
    }
    loadBg()
    window.addEventListener('dashboard-bg-changed', loadBg)
    // Por si dirección le cambia el fondo a otro usuario: esa sesión no se
    // entera al instante (no hay push entre navegadores), así que se
    // comprueba también cada 10 min mientras la pestaña esté abierta.
    const id = setInterval(loadBg, 10 * 60_000)
    return () => {
      window.removeEventListener('dashboard-bg-changed', loadBg)
      clearInterval(id)
      document.body.classList.remove('has-dashboard-bg')
    }
  }, [])

  // "Modo admin simplificado" (users.simplifiedAdminMode, activado desde
  // Usuarios → Editar): sustituye TODA la sesión de este usuario por el
  // Resumen rápido — sin sidebar, sin resto de la app, sin X. La única
  // salida es cerrar sesión (botón dentro del propio AdminQuickStatsModal).
  // Va después de los hooks de arriba para no romper su orden de llamada.
  if (user?.simplifiedAdminMode) return <AdminQuickStatsModal />

  return (
    <>
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} />}
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div id="main">
        <Topbar onMenuClick={() => setNavOpen(o => !o)} />
        <UrgentAlertsBar />
        <EngagementWeeklyPopup />
        <ImportantStaffMessagePopup />
        <DailyReceptionReminderPopup />
        <BreakfastLockGuard />
        <AdminQuickStats />
        <main id="content">
          <Outlet />
        </main>
        {bgCredit && <div className="dashboard-bg-credit">{bgCredit}</div>}
      </div>
    </>
  )
}
