// Cliente API — todas las llamadas al backend pasan por aquí

const BASE = '/api'

async function req(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(BASE + path, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  // ─── Dashboard ────────────────────────────────────────────────────────────
  dashboard:    () => req('GET', '/dashboard'),
  arrivals:     (date) => req('GET', '/dashboard/arrivals'   + (date ? '?date=' + date : '')),
  departures:   (date) => req('GET', '/dashboard/departures' + (date ? '?date=' + date : '')),
  inHouse:      () => req('GET', '/dashboard/in-house'),
  billingReport:(params = {}) => req('GET', '/dashboard/billing?' + new URLSearchParams(params)),

  // ─── Reservaciones ────────────────────────────────────────────────────────
  listReservations:      (params = {}) => req('GET', '/reservations?' + new URLSearchParams(params)),
  planningReservations:  (params = {}) => req('GET', '/reservations/planning?' + new URLSearchParams(params)),
  searchReservations: (q)           => req('GET', '/reservations/search?q=' + encodeURIComponent(q)),
  getReservation:     (id)          => req('GET', `/reservations/${id}`),
  createReservation:  (data)        => req('POST', '/reservations', data),
  updateReservation:  (id, data)    => req('PATCH', `/reservations/${id}`, data),
  checkIn:            (id, data)    => req('POST', `/reservations/${id}/check-in`, data ?? {}),
  checkOut:           (id)          => req('POST', `/reservations/${id}/check-out`),
  cancelReservation:  (id)          => req('POST', `/reservations/${id}/cancel`),
  addNote:            (id, note)    => req('POST', `/reservations/${id}/notes`, { note }),

  // ─── Huéspedes ────────────────────────────────────────────────────────────
  listGuests:   (params = {}) => req('GET', '/guests?' + new URLSearchParams(params)),
  getGuest:     (id)          => req('GET', `/guests/${id}`),
  createGuest:  (data)        => req('POST', '/guests', data),
  updateGuest:  (id, data)    => req('PATCH', `/guests/${id}`, data),

  // ─── Habitaciones ─────────────────────────────────────────────────────────
  listRooms:        ()         => req('GET', '/rooms'),
  listRoomTypes:    ()         => req('GET', '/rooms/types'),
  getAvailability:  (params)   => req('GET', '/rooms/availability?' + new URLSearchParams(params)),
  getBedView:       (params)   => req('GET', '/rooms/bed-view?' + new URLSearchParams(params)),

  // ─── Catálogo ─────────────────────────────────────────────────────────────
  listRates:          ()         => req('GET', '/catalog/rates'),
  updateRate:         (id, data) => req('PATCH', `/catalog/rates/${id}`, data),
  lockRate:           (id)       => req('POST', `/catalog/rates/${id}/lock`),
  unlockRate:         (id)       => req('POST', `/catalog/rates/${id}/unlock`),
  ratesCalendar:      (p)        => req('GET', '/catalog/rates/calendar?' + new URLSearchParams(p)),
  setDailyPrice:      (id, date, data)  => req('PUT',    `/catalog/rates/${id}/prices/${date}`, data),
  bulkDailyPrices:    (id, entries)     => req('POST',   `/catalog/rates/${id}/prices/bulk`, { entries }),
  deleteDailyPrice:   (id, date)        => req('DELETE', `/catalog/rates/${id}/prices/${date}`),
  listOperators:      ()         => req('GET', '/catalog/operators'),
  createOperator:     (data)     => req('POST', '/catalog/operators', data),
  updateOperator:     (id, data) => req('PATCH', `/catalog/operators/${id}`, data),
  listChannels:       ()         => req('GET', '/catalog/booking-channels'),
  listSaleItems:      ()         => req('GET', '/catalog/sale-items'),
  listDepositItems:   ()         => req('GET', '/catalog/deposit-items'),

  // ─── Financiero ───────────────────────────────────────────────────────────
  listAccounts:     ()         => req('GET', '/financial/accounts'),
  listTransactions: (params)   => req('GET', '/financial/transactions?' + new URLSearchParams(params)),
  createTransaction:(data)     => req('POST', '/financial/transactions', data),
  listInvoices:     (params)   => req('GET', '/financial/invoices?' + new URLSearchParams(params)),
  getInvoice:       (id)       => req('GET', `/financial/invoices/${id}`),
  createInvoiceFromReservation: (reservationId) => req('POST', `/financial/invoices/from-reservation/${reservationId}`),
  paymentReport:    (data)     => req('POST', '/financial/reports/payments', data),

  // ─── Notificaciones ───────────────────────────────────────────────────────
  listNotifications: () => req('GET', '/notifications'),
  markNotificationsRead: () => req('POST', '/notifications/mark-read'),
}
