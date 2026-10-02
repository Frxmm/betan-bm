import { db } from './index'
import {
  properties, currencies, countries, users,
  roomTypes, rooms,
  bookingChannels, rates,
  guests, reservations, reservationNights,
  financialAccounts, saleItems, depositItems,
} from './schema'

async function seed() {
  console.log('🌱 Iniciando seed...')

  // ─── CURRENCIES ───────────────────────────────────────────────────────────
  const [eur] = await db.insert(currencies).values([
    { code: 'EUR', name: 'Euro' },
    { code: 'USD', name: 'US Dollar' },
    { code: 'GBP', name: 'British Pound' },
  ]).onConflictDoNothing().returning()
  const eurId = eur?.id ?? (await db.query.currencies.findFirst({ where: (c, { eq }) => eq(c.code, 'EUR') }))!.id
  console.log('✓ Monedas')

  // ─── COUNTRIES ────────────────────────────────────────────────────────────
  const [spain] = await db.insert(countries).values([
    { code: 'ES', codeAlpha3: 'ESP', name: 'España' },
    { code: 'FR', codeAlpha3: 'FRA', name: 'Francia' },
    { code: 'DE', codeAlpha3: 'DEU', name: 'Alemania' },
    { code: 'GB', codeAlpha3: 'GBR', name: 'Reino Unido' },
    { code: 'US', codeAlpha3: 'USA', name: 'Estados Unidos' },
    { code: 'IT', codeAlpha3: 'ITA', name: 'Italia' },
    { code: 'PT', codeAlpha3: 'PRT', name: 'Portugal' },
    { code: 'NL', codeAlpha3: 'NLD', name: 'Países Bajos' },
  ]).onConflictDoNothing().returning()
  const spainId = spain?.id ?? (await db.query.countries.findFirst({ where: (c, { eq }) => eq(c.code, 'ES') }))!.id
  console.log('✓ Países')

  // ─── PROPERTY ─────────────────────────────────────────────────────────────
  // Tenant de demostración neutro (slug 'demo'). Para un hotel real usa scripts/create-tenant.ts.
  const [property] = await db.insert(properties).values({
    slug: 'demo',
    name: 'Hotel Demo',
    legalName: 'Hotel Demo S.L.',
    address: 'Calle Mayor 1',
    city: 'Madrid',
    countryCode: 'ES',
    phone: '+34 910 000 000',
    email: 'info@example.com',
    currencyCode: 'EUR',
    timezone: 'Europe/Madrid',
  }).onConflictDoNothing().returning()
  const propId = property?.id ?? (await db.query.properties.findFirst({ where: (p, { eq }) => eq(p.slug, 'demo') }))!.id
  console.log('✓ Propiedad')

  // ─── USER (admin) ─────────────────────────────────────────────────────────
  await db.insert(users).values({
    propertyId: propId,
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'Demo',
    passwordHash: await Bun.password.hash(process.env.SEED_ADMIN_PASSWORD ?? 'cambia-esta-contraseña'),
    isPrimary: true,
    languageCode: 'es',
    active: true,
  }).onConflictDoNothing()
  console.log('✓ Usuario admin')

  // ─── ROOM TYPES ───────────────────────────────────────────────────────────
  const roomTypeRows = await db.insert(roomTypes).values([
    { propertyId: propId, name: 'Habitación Individual',  prefix: 'IND', roomClass: 6, maxOccupancy: 1, ensuite: true,  defaultPrice: '55.00',  orderIndex: 1 },
    { propertyId: propId, name: 'Habitación Doble',       prefix: 'DBL', roomClass: 7, maxOccupancy: 2, ensuite: true,  defaultPrice: '80.00',  orderIndex: 2 },
    { propertyId: propId, name: 'Habitación Doble Ensuite', prefix: 'DBE', roomClass: 8, maxOccupancy: 2, ensuite: true, allowExtraBeds: 1, extraBedPrice: '25.00', defaultPrice: '95.00', orderIndex: 3 },
    { propertyId: propId, name: 'Habitación Cuádruple',   prefix: 'CUA', roomClass: 9, maxOccupancy: 4, ensuite: true,  defaultPrice: '140.00', orderIndex: 4 },
    { propertyId: propId, name: 'Dormitorio Compartido',  prefix: 'DOM', roomClass: 5, maxOccupancy: 8, ensuite: false, defaultPrice: '22.00',  orderIndex: 5 },
  ]).onConflictDoNothing().returning()
  const [ind, dbl, dbe, cua, dom] = roomTypeRows.length > 0
    ? roomTypeRows
    : await db.query.roomTypes.findMany({ orderBy: (t, { asc }) => asc(t.orderIndex) })
  console.log('✓ Tipos de habitación')

  // ─── ROOMS ────────────────────────────────────────────────────────────────
  await db.insert(rooms).values([
    { propertyId: propId, roomTypeId: ind.id, code: '101', orderIndex: 1,  startingBedNumber: 1, backgroundColor: '#E8F5E9', fontColor: '#1B5E20' },
    { propertyId: propId, roomTypeId: dbl.id, code: '102', orderIndex: 2,  startingBedNumber: 1, backgroundColor: '#E3F2FD', fontColor: '#0D47A1' },
    { propertyId: propId, roomTypeId: dbl.id, code: '103', orderIndex: 3,  startingBedNumber: 1, backgroundColor: '#E3F2FD', fontColor: '#0D47A1' },
    { propertyId: propId, roomTypeId: dbe.id, code: '201', orderIndex: 4,  startingBedNumber: 1, backgroundColor: '#F3E5F5', fontColor: '#4A148C' },
    { propertyId: propId, roomTypeId: dbe.id, code: '202', orderIndex: 5,  startingBedNumber: 1, backgroundColor: '#F3E5F5', fontColor: '#4A148C' },
    { propertyId: propId, roomTypeId: cua.id, code: '301', orderIndex: 6,  startingBedNumber: 1, backgroundColor: '#FFF3E0', fontColor: '#E65100' },
    { propertyId: propId, roomTypeId: dom.id, code: 'DOM-A', orderIndex: 7, startingBedNumber: 1, backgroundColor: '#FCE4EC', fontColor: '#880E4F' },
  ]).onConflictDoNothing()
  console.log('✓ Habitaciones')

  // ─── BOOKING CHANNELS ─────────────────────────────────────────────────────
  await db.insert(bookingChannels).values([
    { propertyId: propId, name: 'Directo',        isDefault: true,  active: true },
    { propertyId: propId, name: 'Booking.com',    isDefault: false, active: true },
    { propertyId: propId, name: 'Airbnb',         isDefault: false, active: true },
    { propertyId: propId, name: 'Expedia',        isDefault: false, active: true },
    { propertyId: propId, name: 'Hostelworld',    isDefault: false, active: true },
    { propertyId: propId, name: 'Teléfono',       isDefault: false, active: true },
  ]).onConflictDoNothing()
  console.log('✓ Canales de venta')

  // ─── RATES ────────────────────────────────────────────────────────────────
  await db.insert(rates).values([
    { propertyId: propId, title: 'Tarifa Estándar',         code: 'STD', active: true, activeForBookingEngine: true },
    { propertyId: propId, title: 'Tarifa No Reembolsable',  code: 'NRF', active: true, activeForBookingEngine: true },
    { propertyId: propId, title: 'Tarifa Web Directa',      code: 'WEB', active: true, activeForBookingEngine: true },
    { propertyId: propId, title: 'Tarifa Grupos',           code: 'GRP', active: true, activeForBookingEngine: false },
  ]).onConflictDoNothing()
  console.log('✓ Tarifas')

  // ─── FINANCIAL ACCOUNTS ───────────────────────────────────────────────────
  await db.insert(financialAccounts).values([
    { propertyId: propId, name: 'Caja efectivo',     isDefault: true,  isCreditCard: false, isBankAccount: false, countInShift: true  },
    { propertyId: propId, name: 'TPV tarjeta',       isDefault: false, isCreditCard: true,  isBankAccount: false, countInShift: true  },
    { propertyId: propId, name: 'Transferencia bancaria', isDefault: false, isCreditCard: false, isBankAccount: true, countInShift: false },
    { propertyId: propId, name: 'Pasarela online',   isDefault: false, isCreditCard: true,  isBankAccount: false, countInShift: false },
  ]).onConflictDoNothing()
  console.log('✓ Cuentas financieras')

  // ─── SALE ITEMS ───────────────────────────────────────────────────────────
  await db.insert(saleItems).values([
    { propertyId: propId, title: 'Desayuno',          defaultPrice: '8.00',  active: true, isAddOn: true  },
    { propertyId: propId, title: 'Parking',           defaultPrice: '12.00', active: true, isAddOn: true  },
    { propertyId: propId, title: 'Traslado aeropuerto', defaultPrice: '35.00', active: true, isAddOn: false },
    { propertyId: propId, title: 'Tasa turística',    defaultPrice: '2.00',  active: true, isAddOn: false, taxRate: '10.00' },
    { propertyId: propId, title: 'Cama extra',        defaultPrice: '25.00', active: true, isAddOn: true  },
    { propertyId: propId, title: 'Late check-out',    defaultPrice: '20.00', active: true, isAddOn: false },
  ]).onConflictDoNothing()
  console.log('✓ Productos extras')

  // ─── DEPOSIT ITEMS ────────────────────────────────────────────────────────
  await db.insert(depositItems).values([
    { propertyId: propId, name: 'DNI / Pasaporte',   active: true, requiredForCheckIn: true  },
    { propertyId: propId, name: 'Tarjeta de crédito', active: true, requiredForCheckIn: false },
    { propertyId: propId, name: 'Depósito efectivo',  active: true, requiredForCheckIn: false },
  ]).onConflictDoNothing()
  console.log('✓ Depósitos')

  // ─── SAMPLE GUESTS ────────────────────────────────────────────────────────
  const guestRows = await db.insert(guests).values([
    { propertyId: propId, firstName: 'María',    lastName: 'García',    email: 'maria.garcia@example.com',   phone: '+34 600 111 222', gender: 'female', countryId: spainId },
    { propertyId: propId, firstName: 'Carlos',   lastName: 'López',     email: 'carlos.lopez@example.com',   phone: '+34 600 333 444', gender: 'male',   countryId: spainId },
    { propertyId: propId, firstName: 'John',     lastName: 'Smith',     email: 'john.smith@example.com',     phone: '+44 7700 900123', gender: 'male' },
    { propertyId: propId, firstName: 'Sophie',   lastName: 'Müller',    email: 'sophie.muller@example.com',  phone: '+49 151 23456789', gender: 'female' },
    { propertyId: propId, firstName: 'Ana',      lastName: 'Martínez',  email: 'ana.martinez@example.com',   phone: '+34 600 555 666', gender: 'female', countryId: spainId, isVip: true },
    { propertyId: propId, firstName: 'Pierre',   lastName: 'Dubois',    email: 'pierre.dubois@example.com',  phone: '+33 6 12 34 56 78', gender: 'male' },
  ]).onConflictDoNothing().returning()
  console.log('✓ Huéspedes de muestra')

  // ─── SAMPLE RESERVATIONS ──────────────────────────────────────────────────
  const today = new Date()
  const fmt = (d: Date) => d.toISOString().split('T')[0]
  const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate() + n); return r }

  const roomList = await db.query.rooms.findMany({ orderBy: (r, { asc }) => asc(r.orderIndex) })
  const rateList = await db.query.rates.findMany()
  const channelList = await db.query.bookingChannels.findMany()

  if (guestRows.length > 0 && roomList.length > 0) {
    const sampleRes = [
      // Llegada hoy
      { guestIdx: 0, roomIdx: 1, checkIn: fmt(today),          nights: 3, status: 'confirmed' as const,    total: '240.00', amountPaid: '80.00' },
      // Llegada hoy (otro)
      { guestIdx: 1, roomIdx: 2, checkIn: fmt(today),          nights: 2, status: 'confirmed' as const,    total: '160.00', amountPaid: '160.00' },
      // En casa (llegó ayer)
      { guestIdx: 2, roomIdx: 3, checkIn: fmt(addDays(today,-1)), nights: 4, status: 'checked_in' as const, total: '380.00', amountPaid: '190.00' },
      // Sale hoy
      { guestIdx: 4, roomIdx: 0, checkIn: fmt(addDays(today,-2)), nights: 2, status: 'checked_in' as const, total: '110.00', amountPaid: '110.00' },
      // Futura
      { guestIdx: 3, roomIdx: 4, checkIn: fmt(addDays(today,3)), nights: 5, status: 'confirmed' as const,   total: '475.00', amountPaid: '0.00' },
      // Futura
      { guestIdx: 5, roomIdx: 5, checkIn: fmt(addDays(today,7)), nights: 2, status: 'tentative' as const,   total: '280.00', amountPaid: '0.00' },
    ]

    for (const s of sampleRes) {
      const checkOutDate = fmt(addDays(new Date(s.checkIn), s.nights))
      const [res] = await db.insert(reservations).values({
        propertyId: propId,
        status: s.status,
        checkInDate: s.checkIn,
        checkOutDate,
        nights: s.nights,
        guestId: guestRows[s.guestIdx].id,
        roomId: roomList[s.roomIdx].id,
        rateId: rateList[0]?.id,
        bookingChannelId: channelList[0]?.id,
        currencyId: eurId,
        total: s.total,
        amountPaid: s.amountPaid,
        people: 2,
      } as any).returning()

      // Crear reservation_nights
      for (let i = 0; i < s.nights; i++) {
        const nightDate = fmt(addDays(new Date(s.checkIn), i))
        await db.insert(reservationNights).values({
          reservationId: res.id,
          date: nightDate,
          guestId: guestRows[s.guestIdx].id,
          roomId: roomList[s.roomIdx].id,
          roomTypeId: roomList[s.roomIdx].roomTypeId,
          rateId: rateList[0]?.id,
          price: (Number(s.total) / s.nights).toFixed(2),
          currencyId: eurId,
        })
      }
    }
    console.log('✓ Reservas de muestra')
  }

  console.log('\n✅ Seed completado con éxito')
  process.exit(0)
}

seed().catch(err => {
  console.error('❌ Error en seed:', err)
  process.exit(1)
})
