import { relations } from 'drizzle-orm'
import { properties, currencies, countries, users, userRoles } from './core'
import { guests } from './guests'
import { roomTypes, rooms } from './rooms'
import {
  operators, bookingChannels, rates, rateDailyPrices,
  reservations, reservationNights, reservationNotes,
} from './reservations'
import {
  financialAccounts, financialTransactions, shifts,
  saleItems, depositItems, invoices, notifications, blockedBeds,
  reservationSaleItems,
} from './financial'
import { alertEvents } from './alerts'
import { competitorHotels, competitorPrices } from './competitors'

export const propertiesRelations = relations(properties, ({ many }) => ({
  users:                many(users),
  roomTypes:            many(roomTypes),
  rooms:                many(rooms),
  guests:               many(guests),
  reservations:         many(reservations),
  bookingChannels:      many(bookingChannels),
  rates:                many(rates),
  financialAccounts:    many(financialAccounts),
  saleItems:            many(saleItems),
  notifications:        many(notifications),
}))

export const currenciesRelations = relations(currencies, ({ many }) => ({
  reservations:         many(reservations),
  reservationNights:    many(reservationNights),
  financialTransactions: many(financialTransactions),
  invoices:             many(invoices),
}))

export const countriesRelations = relations(countries, ({ many }) => ({
  guests: many(guests),
}))

export const usersRelations = relations(users, ({ one, many }) => ({
  property:    one(properties, { fields: [users.propertyId], references: [properties.id] }),
  shifts:      many(shifts),
  roles:       many(userRoles),
}))

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
}))

export const guestsRelations = relations(guests, ({ one, many }) => ({
  property:          one(properties, { fields: [guests.propertyId],  references: [properties.id] }),
  country:           one(countries,  { fields: [guests.countryId],   references: [countries.id] }),
  createdByUser:     one(users,      { fields: [guests.createdBy],   references: [users.id] }),
  reservations:      many(reservations),
  reservationNights: many(reservationNights),
  invoices:          many(invoices),
}))

export const roomTypesRelations = relations(roomTypes, ({ one, many }) => ({
  property:          one(properties, { fields: [roomTypes.propertyId], references: [properties.id] }),
  rooms:             many(rooms),
  reservationNights: many(reservationNights),
}))

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  property:          one(properties, { fields: [rooms.propertyId],   references: [properties.id] }),
  roomType:          one(roomTypes,  { fields: [rooms.roomTypeId],   references: [roomTypes.id] }),
  reservations:      many(reservations),
  reservationNights: many(reservationNights),
}))

export const bookingChannelsRelations = relations(bookingChannels, ({ one, many }) => ({
  property:     one(properties, { fields: [bookingChannels.propertyId], references: [properties.id] }),
  reservations: many(reservations),
}))

export const operatorsRelations = relations(operators, ({ one, many }) => ({
  property: one(properties, { fields: [operators.propertyId], references: [properties.id] }),
  rates:    many(rates),
}))

export const ratesRelations = relations(rates, ({ one, many }) => ({
  property:          one(properties,      { fields: [rates.propertyId], references: [properties.id] }),
  operator:          one(operators,       { fields: [rates.operatorId], references: [operators.id] }),
  lockedByUser:      one(users,           { fields: [rates.lockedBy],   references: [users.id] }),
  reservations:      many(reservations),
  reservationNights: many(reservationNights),
  dailyPrices:       many(rateDailyPrices),
}))

export const rateDailyPricesRelations = relations(rateDailyPrices, ({ one }) => ({
  property: one(properties, { fields: [rateDailyPrices.propertyId], references: [properties.id] }),
  rate:     one(rates,      { fields: [rateDailyPrices.rateId],     references: [rates.id] }),
}))

export const reservationsRelations = relations(reservations, ({ one, many }) => ({
  property:       one(properties,     { fields: [reservations.propertyId],       references: [properties.id] }),
  guest:          one(guests,         { fields: [reservations.guestId],          references: [guests.id] }),
  room:           one(rooms,          { fields: [reservations.roomId],           references: [rooms.id] }),
  rate:           one(rates,          { fields: [reservations.rateId],           references: [rates.id] }),
  operator:       one(operators,      { fields: [reservations.operatorId],       references: [operators.id] }),
  bookingChannel: one(bookingChannels,{ fields: [reservations.bookingChannelId], references: [bookingChannels.id] }),
  currency:       one(currencies,     { fields: [reservations.currencyId],       references: [currencies.id] }),
  checkedInByUser:one(users,          { fields: [reservations.checkedInBy],      references: [users.id] }),
  createdByUser:  one(users,          { fields: [reservations.createdBy],        references: [users.id] }),
  nightRows:      many(reservationNights),
  notes:          many(reservationNotes),
  saleItems:      many(reservationSaleItems),
  transactions:   many(financialTransactions),
  invoices:       many(invoices),
}))

export const reservationNightsRelations = relations(reservationNights, ({ one }) => ({
  reservation: one(reservations, { fields: [reservationNights.reservationId], references: [reservations.id] }),
  guest:       one(guests,       { fields: [reservationNights.guestId],       references: [guests.id] }),
  room:        one(rooms,        { fields: [reservationNights.roomId],        references: [rooms.id] }),
  roomType:    one(roomTypes,    { fields: [reservationNights.roomTypeId],    references: [roomTypes.id] }),
  rate:        one(rates,        { fields: [reservationNights.rateId],        references: [rates.id] }),
  currency:    one(currencies,   { fields: [reservationNights.currencyId],    references: [currencies.id] }),
}))

export const reservationNotesRelations = relations(reservationNotes, ({ one }) => ({
  reservation: one(reservations, { fields: [reservationNotes.reservationId], references: [reservations.id] }),
  author:      one(users,        { fields: [reservationNotes.authorId],      references: [users.id] }),
}))

export const reservationSaleItemsRelations = relations(reservationSaleItems, ({ one }) => ({
  reservation: one(reservations, { fields: [reservationSaleItems.reservationId], references: [reservations.id] }),
  saleItem:    one(saleItems,    { fields: [reservationSaleItems.saleItemId],    references: [saleItems.id] }),
  createdByUser: one(users,      { fields: [reservationSaleItems.createdBy],     references: [users.id] }),
}))

export const financialAccountsRelations = relations(financialAccounts, ({ one, many }) => ({
  property:     one(properties, { fields: [financialAccounts.propertyId], references: [properties.id] }),
  transactions: many(financialTransactions),
}))

export const financialTransactionsRelations = relations(financialTransactions, ({ one }) => ({
  property:         one(properties,       { fields: [financialTransactions.propertyId],          references: [properties.id] }),
  reservation:      one(reservations,     { fields: [financialTransactions.reservationId],       references: [reservations.id] }),
  financialAccount: one(financialAccounts,{ fields: [financialTransactions.financialAccountId],  references: [financialAccounts.id] }),
  currency:         one(currencies,       { fields: [financialTransactions.currencyId],          references: [currencies.id] }),
  shift:            one(shifts,           { fields: [financialTransactions.shiftId],             references: [shifts.id] }),
  createdByUser:    one(users,            { fields: [financialTransactions.createdBy],           references: [users.id] }),
  // Quién cobró REALMENTE el pago, tras una corrección de fecha/hora (ver
  // payment_date_corrections) — distinto de createdByUser (quien lo registró
  // en el sistema). Null hasta que se corrija.
  paidByUser:       one(users,            { fields: [financialTransactions.paidByUserId],        references: [users.id] }),
  // Quién marcó un depósito como "cobrado" (ver POST /transactions/:id/cobrar).
  resolvedByUser:   one(users,            { fields: [financialTransactions.resolvedBy],          references: [users.id] }),
}))

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  property:     one(properties, { fields: [shifts.propertyId], references: [properties.id] }),
  openedByUser: one(users,      { fields: [shifts.openedBy],   references: [users.id] }),
  closedByUser: one(users,      { fields: [shifts.closedBy],   references: [users.id] }),
  transactions: many(financialTransactions),
}))

export const saleItemsRelations = relations(saleItems, ({ one, many }) => ({
  property:            one(properties, { fields: [saleItems.propertyId], references: [properties.id] }),
  reservationSaleItems: many(reservationSaleItems),
}))

export const invoicesRelations = relations(invoices, ({ one }) => ({
  property:     one(properties,   { fields: [invoices.propertyId],    references: [properties.id] }),
  reservation:  one(reservations, { fields: [invoices.reservationId], references: [reservations.id] }),
  guest:        one(guests,       { fields: [invoices.guestId],       references: [guests.id] }),
  currency:     one(currencies,   { fields: [invoices.currencyId],    references: [currencies.id] }),
  createdByUser: one(users,       { fields: [invoices.createdBy],     references: [users.id] }),
}))

export const notificationsRelations = relations(notifications, ({ one }) => ({
  property: one(properties, { fields: [notifications.propertyId], references: [properties.id] }),
  sentByUser: one(users,    { fields: [notifications.sentBy],     references: [users.id] }),
}))

export const blockedBedsRelations = relations(blockedBeds, ({ one }) => ({
  property:     one(properties, { fields: [blockedBeds.propertyId], references: [properties.id] }),
  room:         one(rooms,      { fields: [blockedBeds.roomId],     references: [rooms.id] }),
  createdByUser: one(users,     { fields: [blockedBeds.createdBy],  references: [users.id] }),
}))

export const alertEventsRelations = relations(alertEvents, ({ one }) => ({
  property:      one(properties,   { fields: [alertEvents.propertyId],    references: [properties.id] }),
  reservation:   one(reservations, { fields: [alertEvents.reservationId], references: [reservations.id] }),
  silencedByUser: one(users,       { fields: [alertEvents.silencedBy],    references: [users.id] }),
  createdByUser:  one(users,       { fields: [alertEvents.createdBy],     references: [users.id] }),
}))

export const competitorHotelsRelations = relations(competitorHotels, ({ many }) => ({
  prices: many(competitorPrices),
}))

export const competitorPricesRelations = relations(competitorPrices, ({ one }) => ({
  competitor: one(competitorHotels, { fields: [competitorPrices.competitorId], references: [competitorHotels.id] }),
}))
