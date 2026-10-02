import { pgEnum } from 'drizzle-orm/pg-core'

export const reservationStatusEnum = pgEnum('reservation_status', [
  'tentative',   // provisional: carrito web sin pagar / reserva FDM sin confirmar
  'arriving',    // llega hoy y aún no ha hecho check-in ("Por llegar")
  'confirmed',
  'checked_in',
  'checking_out',
  'checked_out',
  'cancelled',
  'no_show',
])

export const genderEnum = pgEnum('gender', [
  'male',
  'female',
  'non_binary',
  'unspecified',
])

export const idDocTypeEnum = pgEnum('id_doc_type', [
  'dni',
  'nie',
  'passport',
  'driving_licence',
  'other',
])

export const paymentMethodEnum = pgEnum('payment_method', [
  'cash',
  'credit_card',
  'bank_transfer',
  'stripe',
  'booking_virtual_card',
  'deposit',
  'deposit_cc',
  'jumbo_credit',
  'other',
])

export const adjustTypeEnum = pgEnum('adjust_type', [
  'fixed',
  'percentage',
])

export const bathroomTypeEnum = pgEnum('bathroom_type', [
  'shower',
  'bathtub',
  'both',
])

export const terraceTypeEnum = pgEnum('terrace_type', [
  'private',
  'shared',
  'none',
])

export const bedSizeEnum = pgEnum('bed_size', [
  'single',
  'twin',
  'double',
  'queen',
  'king',
  'bunk',
])

export const staffRoleEnum = pgEnum('staff_role', [
  'recepcion',
  'conserje',
  'mantenimiento',
  'direccion',
  'limpieza',
  'cocina',
])

export const viewTypeEnum = pgEnum('view_type', [
  'sea',
  'pool',
  'interior',
  'lateral',
  'street',
])
