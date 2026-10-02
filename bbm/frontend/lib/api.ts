// ── Tipos básicos ─────────────────────────────────────────────────────────────

export interface Guest {
  id: number
  firstName: string
  lastName: string
  email?: string
  phone?: string
  documentNumber?: string
}

export interface RoomType {
  id: number
  name: string
  description?: string | null
  prefix?: string | null
  roomClass?: number | null
  maxOccupancy: number
  ensuite: boolean
  allowExtraBeds: number
  extraBedPrice: string
  defaultPrice: string
  orderIndex: number
  bookingEngineLabel?: string | null
  maxOccupancyBookingEngine?: number | null
  color?: string | null
  backgroundColor?: string | null
  fontColor?: string | null
  nobedsRoomId?: number | null
  active: boolean
  baseRoomTypeId?: number | null
  adjustType?: 'fixed' | 'percentage' | 'amount' | null
  adjustValue?: string | null
}

export interface Room {
  id: number
  code: string
  roomTypeId: number
  active: boolean
  orderIndex: number
  startingBedNumber: number
  // Características físicas
  bathroom?: 'shower' | 'bathtub' | 'both' | null
  terrace?: 'private' | 'shared' | 'none' | null
  balcony?: boolean
  bedSize?: 'single' | 'twin' | 'double' | 'queen' | 'king' | 'bunk' | null
  roomSizeSqm?: string | null
  view?: 'sea' | 'pool' | 'interior' | 'lateral' | 'street' | null
  acBrand?: string | null
  tvBrand?: string | null
  lockType?: string | null
  // Override de color (null = hereda del room type)
  color?: string | null
  backgroundColor?: string | null
  fontColor?: string | null
  roomType?: RoomType
}

export interface Reservation {
  id: number
  externalCode?: string
  status: string
  checkInDate: string
  checkOutDate: string
  nights: number
  people: number
  total: string
  amountPaid: string
  guestId: number
  roomId?: number
  rateId?: number
  bookedAt?: string
  extraField2?: string | null
  guest?: Guest
  room?: Room
  notes?: ReservationNote[]
  guestCount?: number
  pendingAmount?: number
  additionalGuests?: { id: number; firstName: string; lastName: string }[]
  onlineCheckIn?: boolean
}

export interface ReservationNote {
  id: number
  note: string
  createdAt: string
  authorId?: number
}

export interface Rate {
  id: number
  title: string
  code?: string
  adjustType?: string
  adjustValue?: string
  baseRateId?: number
  userEditable: boolean
  locked: boolean
  operatorId?: number
  operator?: Operator
  description?: string
}

export interface PriceHistoryItem {
  date: string
  roomTypeName: string
  oldPrice: string | null
  newPrice: string | null
  closed: boolean
}
export interface PriceHistoryBatch {
  batchId: string
  source: 'manual' | 'auto'
  changedAt: string
  userName: string | null   // null = automático
  ruleName: string | null   // solo si source === 'auto' y disparó una regla
  rateTitle: string
  roomTypes: string[]
  datesAffected: string[]
  uniform: boolean          // true si todas las fechas del lote tienen el mismo antes/después
  oldPrice: string | null
  newPrice: string | null
  items: PriceHistoryItem[]
}

export interface Operator {
  id: number
  name: string
  code: string
  logoUrl?: string
  active: boolean
}

export interface RateDailyPrice {
  id: number
  rateId: number
  date: string
  price: string
  closed: boolean
}

export interface DashboardStats {
  arrivals: number
  departures: number
  inHouse: number
  newReservations: number
  totalRevenue?: string
}

export interface ApiList<T> { data: T[] }
export interface ApiItem<T> { data: T }

// ── Cliente ───────────────────────────────────────────────────────────────────

const BASE = '/api'

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(BASE + path, opts)
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:expired'))
    throw new Error('No autenticado')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const raw = (data as any)?.error
    const msg = typeof raw === 'string'
      ? raw
      : (raw?.issues?.[0]?.message ?? raw?.message ?? (data as any)?.message ?? `HTTP ${res.status}`)
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  if (res.status === 204) return null as T
  return res.json() as Promise<T>
}

export interface TenantModule {
  label: string
  group: string
  description: string
  secrets: { name: string; label: string }[]
}

export const api = {
  // ─── Dashboard ────────────────────────────────────────────────────────────
  dashboard:         () => req<ApiItem<DashboardStats>>('GET', '/dashboard'),
  dashboardOccupancy:() => req<{ data: { totalRooms: number; today: { date: string; occupied: number; total: number; pct: number }; week: { from: string; to: string; occupiedNights: number; totalNights: number; pct: number } } }>('GET', '/dashboard/occupancy'),
  arrivals:    (date?: string) => req<ApiList<Reservation>>('GET', '/dashboard/arrivals' + (date ? '?date=' + date : '')),
  departures:  (date?: string) => req<ApiList<Reservation>>('GET', '/dashboard/departures' + (date ? '?date=' + date : '')),
  inHouse:     () => req<ApiList<Reservation>>('GET', '/dashboard/in-house'),
  recentReservations: (limit = 20) => req<ApiList<Reservation>>('GET', `/dashboard/recent?limit=${limit}`),

  // ─── Reservas ─────────────────────────────────────────────────────────────
  listReservations:     (params: Record<string, string> = {}) =>
    req<ApiList<Reservation>>('GET', '/reservations?' + new URLSearchParams(params)),
  searchReservations:   (q: string) =>
    req<ApiList<Reservation>>('GET', '/reservations/search?q=' + encodeURIComponent(q)),
  getReservation:       (id: number) => req<ApiItem<Reservation>>('GET', `/reservations/${id}`),
  createReservation:    (data: unknown) => req<ApiItem<Reservation>>('POST', '/reservations', data),
  updateReservation:    (id: number, data: unknown) => req<ApiItem<Reservation>>('PATCH', `/reservations/${id}`, data),
  checkIn:              (id: number, body?: { checkinStartedAt?: string }) => req<ApiItem<Reservation>>('POST', `/reservations/${id}/check-in`, body ?? {}),
  checkOut:             (id: number, body?: { guestRating?: number }) => req<ApiItem<Reservation>>('POST', `/reservations/${id}/check-out`, body ?? {}),
  cancelReservation:    (id: number) => req<ApiItem<Reservation>>('POST', `/reservations/${id}/cancel`),
  splitReservation:     (id: number, data: { splitDate: string; newRoomId: number }) =>
    req<ApiItem<{ original: Reservation; created: Reservation }>>('POST', `/reservations/${id}/split`, data),
  deleteReservation:    (id: number) => req<{ ok: boolean }>('DELETE', `/reservations/${id}`),
  sendConfirmation:     (id: number) => req<{ data: { sent: boolean; to: string } }>('POST', `/reservations/${id}/send-confirmation`),
  addNote:              (id: number, note: string) => req('POST', `/reservations/${id}/notes`, { note }),
  createContract:       (id: number) => req<ApiItem<{ id: number; url: string; qr: string }>>('POST', `/reservations/${id}/contract`, {}),
  listContracts:        (id: number) => req<ApiList<{ id: number; status: string; signedAt?: string; createdAt: string }>>('GET', `/reservations/${id}/contracts`),
  planningReservations: (params: Record<string, string>) =>
    req<ApiList<Reservation>>('GET', '/reservations/planning?' + new URLSearchParams(params)),

  // ─── Huéspedes ────────────────────────────────────────────────────────────
  listGuests:   (params: Record<string, string> = {}) =>
    req<ApiList<Guest>>('GET', '/guests?' + new URLSearchParams(params)),
  getGuest:     (id: number) => req<ApiItem<Guest>>('GET', `/guests/${id}`),
  createGuest:  (data: unknown) => req<ApiItem<Guest>>('POST', '/guests', data),
  updateGuest:  (id: number, data: unknown) => req<ApiItem<Guest>>('PATCH', `/guests/${id}`, data),
  deleteGuest:  (id: number) => req<ApiItem<{ anonymized: boolean; id: number }>>('DELETE', `/guests/${id}`),

  // ─── Habitaciones ─────────────────────────────────────────────────────────
  listBlockedBeds: () => req<ApiList<any>>('GET', '/rooms/blocked-beds'),
  blockBed:        (data: unknown) => req<ApiItem<any>>('POST', '/rooms/blocked-beds', data),
  unblockBed:      (id: number) => req<null>('DELETE', `/rooms/blocked-beds/${id}`),
  listRooms:       () => req<ApiList<Room>>('GET', '/rooms'),
  getRoomQr:       (id: number) => req<{ url: string; qrDataUrl: string; roomCode: string }>('GET', `/rooms/${id}/qr`),
  availableRoomsForReservation: (p: { checkIn: string; checkOut: string; excludeRoomId?: number; includeVirtual?: boolean }) =>
    req<ApiList<Room>>('GET', `/rooms/available-for-reservation?checkIn=${p.checkIn}&checkOut=${p.checkOut}${p.excludeRoomId ? `&excludeRoomId=${p.excludeRoomId}` : ''}${p.includeVirtual ? '&includeVirtual=true' : ''}`),
  createRoom:      (data: unknown) => req<ApiItem<Room>>('POST', '/rooms', data),
  updateRoom:      (id: number, data: unknown) => req<ApiItem<Room>>('PATCH', `/rooms/${id}`, data),
  deleteRoom:      (id: number) => req<null>('DELETE', `/rooms/${id}`),
  listRoomTypes:   () => req<ApiList<RoomType>>('GET', '/rooms/types'),
  createRoomType:  (data: unknown) => req<ApiItem<RoomType>>('POST', '/rooms/types', data),
  updateRoomType:  (id: number, data: unknown) => req<ApiItem<RoomType>>('PATCH', `/rooms/types/${id}`, data),
  deleteRoomType:  (id: number) => req<null>('DELETE', `/rooms/types/${id}`),
  getAvailability: (params: Record<string, string>) =>
    req('GET', '/rooms/availability?' + new URLSearchParams(params)),

  // ─── Catálogo: Tarifas ────────────────────────────────────────────────────
  listRates:       () => req<ApiList<Rate>>('GET', '/catalog/rates'),
  updateRate:      (id: number, data: unknown) => req<ApiItem<Rate>>('PATCH', `/catalog/rates/${id}`, data),
  lockRate:        (id: number) => req<ApiItem<Rate>>('POST', `/catalog/rates/${id}/lock`),
  unlockRate:      (id: number) => req<ApiItem<Rate>>('POST', `/catalog/rates/${id}/unlock`),
  deleteRate:      (id: number) => req<{ success: boolean }>('DELETE', `/catalog/rates/${id}`),
  ratesCalendar:   (params: Record<string, string>) =>
    req<{
      rates: Rate[]; allRates: Rate[]; roomTypes: any[];
      priceMap: Record<string, Record<number, Record<string, { price: string; closed: boolean }>>>;
      availTotals: Record<string, number>;
      availOccupied: Record<string, Record<string, number>>;
      availOverrides: Record<string, Record<string, number>>;
      defaultRateIds: number[] | null;
      defaultRoomTypeIds: number[] | null;
      defaultDays: number | null;
      leadTimeWindows: { '6': number | null; '28': number | null; '64': number | null };
      todayIso: string;
      adrByDate: Record<string, number | null>;
    }>('GET', '/catalog/rates/calendar?' + new URLSearchParams(params)),
  setCalendarDefaults: (rateIds: number[] | null, roomTypeIds: number[] | null, days?: number) =>
    req<ApiItem<{ ok: boolean }>>('PUT', '/catalog/rates/calendar-defaults', { rateIds, roomTypeIds, days }),
  priceHistory: (params: Record<string, string>) =>
    req<{ data: PriceHistoryBatch[] }>('GET', '/catalog/rates/price-history?' + new URLSearchParams(params)),
  setDailyPrice:   (id: number, date: string, data: { price?: number; closed?: boolean; roomTypeId?: number | null }) =>
    req<ApiItem<RateDailyPrice>>('PUT', `/catalog/rates/${id}/prices/${date}`, data),
  bulkDailyPrices: (id: number, entries: { date: string; price?: number; closed?: boolean; roomTypeId?: number | null }[]) =>
    req('POST', `/catalog/rates/${id}/prices/bulk`, { entries }),
  deleteDailyPrice:(id: number, date: string, roomTypeId?: number | null) =>
    req('DELETE', `/catalog/rates/${id}/prices/${date}${roomTypeId != null ? `?roomTypeId=${roomTypeId}` : ''}`),
  setAvailOverride:   (roomTypeId: number, date: string, maxAvail: number) =>
    req('PUT',    `/catalog/avail/${roomTypeId}/${date}`, { maxAvail }),
  clearAvailOverride: (roomTypeId: number, date: string) =>
    req('DELETE', `/catalog/avail/${roomTypeId}/${date}`),

  // ─── Catálogo: Operadores ─────────────────────────────────────────────────
  listOperators:   () => req<ApiList<Operator>>('GET', '/catalog/operators'),
  createOperator:  (data: unknown) => req<ApiItem<Operator>>('POST', '/catalog/operators', data),
  updateOperator:  (id: number, data: unknown) => req<ApiItem<Operator>>('PATCH', `/catalog/operators/${id}`, data),

  // ─── Catálogo: Canales ────────────────────────────────────────────────────
  listChannels: () => req<ApiList<{ id: number; name: string; code?: string }>>('GET', '/catalog/channels'),

  // ─── Catálogo: Extras (sale items) ───────────────────────────────────────
  listSaleItems:   () => req<ApiList<any>>('GET', '/catalog/sale-items'),
  listExtraSales:  (params: Record<string, string> = {}) =>
    req<{ data: any[]; meta: { total: number; totalAmount: string; page: number; limit: number } }>(
      'GET', '/catalog/sale-items/sales?' + new URLSearchParams(params)
    ),
  markAlertSeen:   (alertType: string) => req<{ ok: boolean }>('POST', '/alerts/seen', { alertType }),
  createSaleItem:  (data: unknown) => req<ApiItem<any>>('POST', '/catalog/sale-items', data),
  updateSaleItem:  (id: number, data: unknown) => req<ApiItem<any>>('PATCH', `/catalog/sale-items/${id}`, data),
  deleteSaleItem:  (id: number) => req<{ ok: boolean }>('DELETE', `/catalog/sale-items/${id}`),

  // ─── Financiero ───────────────────────────────────────────────────────────
  listAccounts:        () => req<{ data: any[] }>('GET', '/financial/accounts'),
  createAccount:       (data: unknown) => req<{ data: any }>('POST', '/financial/accounts', data),
  updateAccount:       (id: number, data: unknown) => req<{ data: any }>('PATCH', `/financial/accounts/${id}`, data),
  deleteAccount:       (id: number) => req<{ data: any }>('DELETE', `/financial/accounts/${id}`),
  updateTransaction:   (id: number, data: unknown) => req<{ data: any }>('PATCH', `/financial/transactions/${id}`, data),
  correctTransactionDate: (id: number, data: { date: string; time: string; paidByUserId: number }) =>
    req<{ data: any }>('POST', `/financial/transactions/${id}/correct-date`, data),
  listPaymentMethods:  () => req<{ data: any[] }>('GET', '/financial/payment-methods'),
  createPaymentMethod: (data: unknown) => req<{ data: any }>('POST', '/financial/payment-methods', data),
  updatePaymentMethod: (id: number, data: unknown) => req<{ data: any }>('PATCH', `/financial/payment-methods/${id}`, data),
  deletePaymentMethod: (id: number) => req<{ data: any }>('DELETE', `/financial/payment-methods/${id}`),
  listTransactions: (params: Record<string, string> = {}) =>
    req<{ data: any[]; meta: { total: number; totalAmount: string; page: number; limit: number } }>(
      'GET', '/financial/transactions?' + new URLSearchParams(params)
    ),
  listCashCollections:  (params: Record<string, string> = {}) =>
    req<{ data: any[]; pending: string; dateFrom: string | null; dateTo: string | null }>(
      'GET', '/financial/cash-collections?' + new URLSearchParams(params)
    ),
  createCashCollection: (data: { collectedAt?: string; dateFrom?: string | null; dateTo?: string | null; note?: string }) =>
    req<{ data: any }>('POST', '/financial/cash-collections', data),
  listInvoices:               (params: Record<string, string> = {}) =>
    req('GET', '/financial/invoices?' + new URLSearchParams(params)),
  getInvoice:                 (id: number) => req('GET', `/financial/invoices/${id}`),
  createInvoiceFromReservation: (reservationId: number, amount?: number) =>
    req('POST', `/financial/invoices/from-reservation/${reservationId}`, amount != null ? { amount } : {}),
  billingReport: (params: Record<string, string> = {}) =>
    req<{ data: Reservation[]; meta: { totalRevenue: string; totalPaid: string; totalDue: string; count: number; byChannel: Record<string, { count: number; revenue: number; paid: number }> } }>(
      'GET', '/dashboard/billing?' + new URLSearchParams(params)
    ),
  paymentReport:  (data: unknown) => req('POST', '/financial/reports/payments', data),
  paymentSummary: (params: Record<string, string>) =>
    req<{ data: any[]; meta: { count: number; total: string; byMethod: Record<string, { count: number; total: number }>; byAccount: Record<string, { count: number; total: number }> } }>(
      'GET', '/financial/reports/summary?' + new URLSearchParams(params)
    ),
  createRate:    (data: unknown) => req<ApiItem<Rate>>('POST', '/catalog/rates', data),

  // ─── Catálogo: Temporadas ─────────────────────────────────────────────────
  listSeasons:    () => req<ApiList<any>>('GET', '/catalog/seasons'),
  createSeason:   (data: unknown) => req<ApiItem<any>>('POST', '/catalog/seasons', data),
  updateSeason:   (id: number, data: unknown) => req<ApiItem<any>>('PATCH', `/catalog/seasons/${id}`, data),
  deleteSeason:   (id: number) => req<{ success: boolean }>('DELETE', `/catalog/seasons/${id}`),

  // ─── Catálogo: Reglas de precio dinámico ─────────────────────────────────
  listPricingRules:   () => req<ApiList<any>>('GET', '/catalog/pricing-rules'),
  createPricingRule:  (data: unknown) => req<ApiItem<any>>('POST', '/catalog/pricing-rules', data),
  updatePricingRule:  (id: number, data: unknown) => req<ApiItem<any>>('PATCH', `/catalog/pricing-rules/${id}`, data),
  deletePricingRule:  (id: number) => req<{ success: boolean }>('DELETE', `/catalog/pricing-rules/${id}`),

  getCartRecoverySettings: () => req<ApiItem<any>>('GET', '/catalog/cart-recovery-settings'),
  updateCartRecoverySettings: (data: unknown) => req<ApiItem<any>>('PUT', '/catalog/cart-recovery-settings', data),

  getCancellationRecoverySettings: () => req<ApiItem<any>>('GET', '/catalog/cancellation-recovery-settings'),
  updateCancellationRecoverySettings: (data: unknown) => req<ApiItem<any>>('PUT', '/catalog/cancellation-recovery-settings', data),

  getTemporaryDiscountSettings: () => req<ApiItem<any>>('GET', '/catalog/temporary-discount-settings'),
  updateTemporaryDiscountSettings: (data: unknown) => req<ApiItem<any>>('PUT', '/catalog/temporary-discount-settings', data),

  // ─── Informes ─────────────────────────────────────────────────────────────
  getOccupancyReport: (params: Record<string, string>) =>
    req<{ data: any[]; meta: any }>('GET', '/reports/occupancy?' + new URLSearchParams(params)),
  getAbandonedCarts: (from: string, to: string) =>
    req<{
      data: { day: string; carts: number; amount: string; emails_sent: number; recovered: number; recovered_amount: string }[]
      meta: { carts: number; amount: number; emailsSent: number; recovered: number; recoveredAmount: number }
      carts: {
        id: number; reservationId: number; createdAt: string
        email: string | null; phone: string | null; guestName: string | null; amount: string
        checkIn: string | null; checkOut: string | null; discountPct: number
        emailSentAt: string | null; emailError: string | null; emailSkipReason: string | null
        whatsappSentAt: string | null; whatsappError: string | null
        recoveredAt: string | null; recoveredAmount: string | null
        reservationStatus: string
      }[]
    }>('GET', `/reports/abandoned-carts?from=${from}&to=${to}`),
  getRoomAccessVisits: (from: string, to: string) =>
    req<{
      data: { day: string; visits: number }[]
      meta: { totalVisits: number; daysWithVisits: number; avgPerDay: number; busiestDay: { day: string; visits: number } | null }
    }>('GET', `/reports/room-access-visits?from=${from}&to=${to}`),
  getChannelSalesReport: (params: Record<string, string>) =>
    req<{ data: any[]; meta: any }>('GET', '/reports/channel-sales?' + new URLSearchParams(params)),
  getCancellationsReport: (params: Record<string, string>) =>
    req<{ data: any[]; byCancelDate: any[]; byStayDate: any[] }>('GET', '/reports/cancellations?' + new URLSearchParams(params)),
  getCancellationsDetail: (params: Record<string, string>) =>
    req<{ data: {
      id: number; name: string | null; email: string | null; phone: string | null
      checkInDate: string; checkOutDate: string; originalAmount: number; currentAmount: number | null
    }[] }>('GET', '/reports/cancellations/detail?' + new URLSearchParams(params)),
  getCancellationRecoveries: (from: string, to: string) =>
    req<{ data: any[]; meta: { count: number; emailsSent: number; recovered: number; recoveredAmount: number } }>(
      'GET', `/reports/cancellation-recoveries?from=${from}&to=${to}`),
  getLeadTimeReport: (params: Record<string, string>) =>
    req<{ data: any[] }>('GET', '/reports/lead-time?' + new URLSearchParams(params)),
  getCheckinTimeReport: (params: Record<string, string>) =>
    req<{ data: any[]; byEmployee: any[]; meta: any }>('GET', '/reports/checkin-time?' + new URLSearchParams(params)),
  getPaymentCorrectionsReport: (params: Record<string, string>) =>
    req<{ data: any[]; byEmployee: any[]; byDay: any[]; meta: { total: number } }>('GET', '/reports/payment-corrections?' + new URLSearchParams(params)),
  getCommissionsReport: (params: Record<string, string>) =>
    req<{ data: any[]; channels: { id: number; name: string; commissionPct: string | null }[]; meta: any }>(
      'GET', '/reports/commissions?' + new URLSearchParams(params)),
  updateChannelCommission: (channelId: number, commissionPct: number | null) =>
    req<{ ok: boolean }>('PATCH', `/reports/commissions/${channelId}`, { commissionPct }),
  logCheckinStart: (id: number) =>
    req<{ data: { ok: boolean } }>('POST', `/reservations/${id}/checkin-start`, {}),
  getBreakfastReport: (from: string, to: string) =>
    req<{ data: any[]; totals: any }>('GET', `/reports/breakfast?from=${from}&to=${to}`),
  getLaundryReport: (from: string, to: string) =>
    req<{ deliveredByDay: any[]; deliveredByEmployee: any[]; processedByEmployee: any[]; byStatus: Record<string, number>; byType: Record<string, number>; meta: any }>(
      'GET', `/reports/laundry?from=${from}&to=${to}`),
  getHousekeepingStaffReport: (from: string, to: string) =>
    req<{ data: any[]; byEmployee: any[]; meta: any }>(
      'GET', `/reports/housekeeping-staff?from=${from}&to=${to}`),

  // ─── Nobeds ───────────────────────────────────────────────────────────────
  nobedsPushPrices: (from: string, to: string, rateCode = 'Expedia AL') =>
    req<{ data: { pushed: number; skipped: number; errors: number; errorList: string[] } }>(
      'POST', '/nobeds/push-prices', { from, to, rateCode }
    ),

  // ─── FDM ──────────────────────────────────────────────────────────────────
  fdmSyncReservations: (from: string, to: string) =>
    req<{ data: { imported: number; updated: number; skipped: number; errors: number; invImported: number; invErrors: number; txImported: number; txErrors: number; total: number; from: string; to: string } }>(
      'POST', '/fdm/sync-reservations', { from, to }
    ),
  // ─── Usuarios ─────────────────────────────────────────────────────────────
  listUsers:   () => req<ApiList<any>>('GET', '/users'),
  createUser:  (data: unknown) => req<ApiItem<any>>('POST', '/users', data),
  updateUser:  (id: number, data: unknown) => req<ApiItem<any>>('PATCH', `/users/${id}`, data),
  deleteUser:  (id: number) => req<null>('DELETE', `/users/${id}`),

  // ─── Reglas de edición de campos de reserva ───────────────────────────────
  getFieldRules:    () => req<ApiList<any>>('GET', '/settings/field-rules'),
  updateFieldRules: (rules: { fieldKey: string; allowedRoles: string[]; allowedChannelIds: number[] }[]) =>
    req<ApiItem<{ ok: boolean }>>('PUT', '/settings/field-rules', rules),

  // ─── Nombres/apellidos bloqueados al crear/editar huéspedes ────────────────
  getBlockedGuestNames:    () => req<ApiItem<string[]>>('GET', '/settings/blocked-guest-names'),
  updateBlockedGuestNames: (names: string[]) =>
    req<ApiItem<string[]>>('PUT', '/settings/blocked-guest-names', { names }),

  // ─── Canales exentos de "debe estar saldada para check-in" (código TTLock) ──
  getTtlockBalanceExemptChannels:    () => req<ApiItem<number[]>>('GET', '/settings/ttlock-balance-exempt-channels'),
  updateTtlockBalanceExemptChannels: (channelIds: number[]) =>
    req<ApiItem<number[]>>('PUT', '/settings/ttlock-balance-exempt-channels', { channelIds }),

  // ─── Alertas (historial, silenciar, alerta manual "Comunicarse con Dirección") ──
  alertsHistory: (params: Record<string, string> = {}) =>
    req<ApiList<any>>('GET', '/alerts/history?' + new URLSearchParams(params)),
  silenceAlert: (entityKey: string) =>
    req<ApiItem<any>>('POST', '/alerts/silence', { entityKey }),
  triggerDireccionUrgente: () =>
    req<ApiItem<any>>('POST', '/alerts/manual/direccion-urgente'),
  alertsEmployeeReport: (params: Record<string, string>) =>
    req<ApiList<any>>('GET', '/alerts/employee-report?' + new URLSearchParams(params)),

  listFeedback: (params: Record<string, string> = {}) => req<ApiList<any>>('GET', '/feedback?' + new URLSearchParams(params)),
  createFeedback: (data: unknown) => req<ApiItem<any>>('POST', '/feedback', data),
  updateFeedback: (id: number, data: unknown) => req<ApiItem<any>>('PATCH', `/feedback/${id}`, data),
  feedbackComments: (id: number) => req<ApiList<any>>('GET', `/feedback/${id}/comments`),
  addFeedbackComment: (id: number, text: string) => req<ApiItem<any>>('POST', `/feedback/${id}/comments`, { text }),
  pricingEffects: (days: number) => req<{ data: any[]; meta: { days: number } }>('GET', `/pricing-effects?days=${days}`),
  listCorporateCompanies: () => req<ApiList<any>>('GET', '/corporate/companies'),
  listCorporateOffers:    () => req<ApiList<any>>('GET', '/corporate/offers'),
  createCorporateOffer:   (data: unknown) => req<ApiItem<any>>('POST', '/corporate/offers', data),
  setCorporateOfferStatus: (id: number, status: string) => req<ApiItem<any>>('PATCH', `/corporate/offers/${id}`, { status }),

  engagementMe: () => req<{ data: any; meta?: any }>('GET', '/engagement/me'),
  engagement: (params: Record<string, string>) =>
    req<{ data: any[]; meta: any }>('GET', '/engagement?' + new URLSearchParams(params)),

  // ─── Competidores (comparativa de precios) ─────────────────────────────────
  listCompetitors:   () => req<ApiList<any>>('GET', '/competitors'),
  createCompetitor:  (data: { name: string; platform: string; config: Record<string, string>; active?: boolean; bookingEffectiveDivisor?: number }) =>
    req<ApiItem<any>>('POST', '/competitors', data),
  updateCompetitor:  (id: number, data: Partial<{ name: string; platform: string; config: Record<string, string>; active: boolean; bookingEffectiveDivisor: number }>) =>
    req<ApiItem<any>>('PATCH', `/competitors/${id}`, data),
  deleteCompetitor:  (id: number) => req<ApiItem<any>>('DELETE', `/competitors/${id}`),
  refreshCompetitor: (id: number) => req<ApiItem<any>>('POST', `/competitors/${id}/refresh`),
  getCompetitorPrices: (from: string, to: string, rateId?: number, roomTypeId?: number) =>
    req<ApiItem<{ hotels: any[]; series: any[] }>>('GET', `/competitors/prices?from=${from}&to=${to}${rateId ? `&rateId=${rateId}` : ''}${roomTypeId ? `&roomTypeId=${roomTypeId}` : ''}`),

  // ─── Escaneo de documentos de identidad ────────────────────────────────────
  idScanSlots: (reservationId: number) =>
    req<ApiItem<{ reservationId: number; people: number; primary: any; additional: any[]; emptySlots: number }>>('GET', `/id-scan/${reservationId}/slots`),
  idScanExtract: (imageDataUrl: string) =>
    req<ApiItem<Record<string, any>>>('POST', '/id-scan/extract', { image: imageDataUrl }),
  idScanApply: (reservationId: number, body: { guestId?: number; fields: Record<string, any> }) =>
    req<ApiItem<any>>('POST', `/id-scan/${reservationId}/apply`, body),

  // ─── Tenants (plataforma) y datos del establecimiento ─────────────────────
  tenantModules:       () => req<ApiItem<{ features: string[]; defaultOn: string[]; modules: Record<string, TenantModule> }>>('GET', '/tenants/modules'),
  listTenants:         () => req<ApiList<any>>('GET', '/tenants'),
  getTenant:           (id: number) => req<ApiItem<any>>('GET', `/tenants/${id}`),
  createTenant:        (data: unknown) => req<ApiItem<any>>('POST', '/tenants', data),
  updateTenant:        (id: number, data: unknown) => req<ApiItem<any>>('PATCH', `/tenants/${id}`, data),
  setTenantFeatures:   (id: number, features: Record<string, boolean>) => req<ApiItem<Record<string, boolean>>>('PUT', `/tenants/${id}/features`, features),
  setTenantSettings:   (id: number, settings: Record<string, unknown>) => req<ApiItem<Record<string, unknown>>>('PUT', `/tenants/${id}/settings`, settings),
  testTenantSecrets:   (id: number, module: string) => req<ApiItem<{ ok: boolean; missing: string[] }>>('POST', `/tenants/${id}/secrets/test`, { module }),
  seedTenant:          (id: number) => req<ApiItem<any>>('POST', `/tenants/${id}/seed`),
  tenantAudit:         (id: number) => req<ApiList<any>>('GET', `/tenants/${id}/audit`),
  deactivateTenant:    (id: number) => req<{ ok: boolean }>('DELETE', `/tenants/${id}`),
  impersonateTenant:   (id: number) => req<ApiItem<any>>('POST', `/tenants/${id}/impersonate`),
  stopImpersonation:   () => req<{ ok: boolean }>('POST', '/tenants/stop-impersonation'),
  getPropertySettings: () => req<ApiItem<any>>('GET', '/settings/property'),
  updatePropertySettings: (data: unknown) => req<ApiItem<any>>('PUT', '/settings/property', data),
  propertyFeatures:    () => req<ApiItem<{ key: string; enabled: boolean; label: string; group: string; description: string }[]>>('GET', '/settings/property/features'),
}
