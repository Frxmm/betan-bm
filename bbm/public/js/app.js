import { initAgent } from './agent.js'
import { renderDashboard }         from './views/dashboard.js'
import { renderReservations }       from './views/reservations.js'
import { renderReservationDetail }  from './views/reservation-detail.js'
import { renderGuests }             from './views/guests.js'
import { renderRooms }              from './views/rooms.js'
import { renderPlanning }           from './views/planning.js'
import { renderArrivals }           from './views/arrivals.js'
import { renderDepartures }         from './views/departures.js'
import { renderBilling }            from './views/billing.js'
import { renderRates }              from './views/rates.js'
import { renderPriceCalendar }      from './views/price-calendar.js'

// ─── ESTADO DE NAVEGACIÓN ─────────────────────────────────────────────────────
let currentView = null

const VIEWS = {
  dashboard:   { label: 'Inicio',       icon: '⌂',  render: (c)     => renderDashboard(c) },
  planning:    { label: 'Planning',     icon: '▦',  render: (c)     => renderPlanning(c) },
  arrivals:    { label: 'Entradas',     icon: '↓',  render: (c)     => renderArrivals(c) },
  departures:  { label: 'Salidas',      icon: '↑',  render: (c)     => renderDepartures(c) },
  billing:     { label: 'Facturación',  icon: '€',  render: (c)     => renderBilling(c) },
  rates:       { label: 'Tarifas',      icon: '₯',  render: (c)     => renderRates(c) },
  prices:      { label: 'Precios',      icon: '▦',  render: (c)     => renderPriceCalendar(c) },
  reservations:{ label: 'Reservas',     icon: '☰',  render: (c)     => renderReservations(c) },
  reservation: { label: 'Reserva',      icon: '☰',  render: (c, id) => renderReservationDetail(c, id), hidden: true },
  guests:      { label: 'Huéspedes',    icon: '👤', render: (c)     => renderGuests(c) },
  rooms:       { label: 'Habitaciones', icon: '🛏',  render: (c)     => renderRooms(c) },
}

// goTo es global para que los onclick inline de las vistas lo puedan usar
window.goTo = function(view, id) {
  currentView = { view, id }
  navigate(view, id)
}

function navigate(view, id) {
  // Actualizar sidebar activo
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'))
  const navLink = document.querySelector(`nav a[data-view="${view}"]`)
  if (navLink) navLink.classList.add('active')

  // Actualizar título del topbar
  const titleMap = {
    dashboard:    'Dashboard',
    planning:     'Planning',
    arrivals:     'Entradas',
    departures:   'Salidas',
    billing:      'Facturación',
    rates:        'Tarifas',
    prices:       'Calendario de Precios',
    reservations: 'Reservas',
    reservation:  `Reserva #${id ?? ''}`,
    guests:       'Huéspedes',
    rooms:        'Habitaciones',
  }
  document.getElementById('page-title').textContent = titleMap[view] ?? view

  // Renderizar la vista
  const content = document.getElementById('content')
  const viewDef = VIEWS[view]
  if (viewDef) {
    viewDef.render(content, id)
  } else {
    content.innerHTML = `<div class="empty"><p>Vista no encontrada: ${view}</p></div>`
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Construir sidebar
  const nav = document.querySelector('nav')
  nav.innerHTML = Object.entries(VIEWS)
    .filter(([, v]) => !v.hidden)
    .map(([key, v]) => `
      <a data-view="${key}" onclick="window.goTo('${key}')">
        <span class="icon">${v.icon}</span>
        ${v.label}
      </a>`).join('')

  // Fecha en topbar
  document.getElementById('topbar-date').textContent =
    new Date().toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })

  // Navegación inicial
  navigate('dashboard')

  // Agente IA
  initAgent()
})
