import { useState, useEffect } from 'react'
import { brand } from './branding'

// ─── Idiomas soportados (mismos que el sitio web del hotel) ────────

export type Lang = 'es' | 'en' | 'fr' | 'de' | 'it' | 'uk' | 'zh'

export const SUPPORTED_LANGS: Lang[] = ['es', 'en', 'fr', 'de', 'it', 'uk', 'zh']

export const LANG_LABELS: Record<Lang, string> = {
  es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch',
  it: 'Italiano', uk: 'Українська', zh: '中文',
}

const STORAGE_KEY = 'hb_widget_lang'

function isSupported(v: string | null): v is Lang {
  return !!v && (SUPPORTED_LANGS as string[]).includes(v)
}

function detectBrowserLang(): Lang {
  const b = (navigator.language || '').split('-')[0]?.toLowerCase() ?? ''
  return isSupported(b) ? b : 'es'
}

// Widgets embebidos en iframe (booking-widget, portal-widget): el idioma lo decide
// la página que los embebe — vía ?lang= en el src del iframe al cargar, o por
// postMessage si cambia sin recargar (el mismo canal ya usado para altura/reset).
export function useWidgetLang(): Lang {
  const [lang, setLang] = useState<Lang>(() => {
    const p = new URLSearchParams(location.search).get('lang')
    return isSupported(p) ? p : 'es'
  })
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if ((e.data?.type === 'bm-widget-lang' || e.data?.type === 'betania-widget-lang') && isSupported(e.data.lang)) setLang(e.data.lang)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  return lang
}

// Páginas standalone (booking.tsx, portal.tsx: se llega por URL directa, ej. desde
// el email de confirmación) — el propio usuario elige idioma con un selector visible.
export function useStandaloneLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return isSupported(saved) ? saved : detectBrowserLang()
  })
  const setLang = (l: Lang) => { localStorage.setItem(STORAGE_KEY, l); setLangState(l) }
  return [lang, setLang]
}

// ─── Helper de traducción con interpolación {{var}} y fallback a español ───────

export function makeT(lang: Lang, dict: Record<Lang, any>) {
  return function t(key: string, vars?: Record<string, string | number>): string {
    const parts = key.split('.')
    let node: any = dict[lang]
    for (const p of parts) node = node?.[p]
    if (node == null) {
      node = dict.es
      for (const p of parts) node = node?.[p]
    }
    let str = typeof node === 'string' ? node : key
    if (vars) for (const [k, v] of Object.entries(vars)) str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    return brand(str)
  }
}

export function plural(_lang: Lang, count: number, one: string, other: string): string {
  return count === 1 ? one : other
}

// ─── Diccionario: motor de reservas (booking.tsx y booking-widget.tsx) ────────

export const BOOKING_I18N: Record<Lang, any> = {
  es: {
    common: {
      back: '← Volver', total: 'Total', processing: 'Procesando…', redirecting: 'Redirigiendo…',
      nightOne: 'noche', nightOther: 'noches', personOne: 'persona', personOther: 'personas',
      perNight: '/noche', perPerson: '/persona', perPersonNight: '/persona/noche', genericError: 'Error',
    },
    booking: {
      pageTitle: 'Reserva tu estancia', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← Volver a la web', myBookings: 'Mis reservas',
      stepAvailability: 'Disponibilidad', stepGuestData: 'Tus datos', stepPayment: 'Pago',
      whenTitle: '¿Cuándo quieres venir?', arrival: 'Llegada', departure: 'Salida',
      guestsSelectLabel: 'Personas', guestsStepperLabel: 'Huéspedes',
      searchButton: 'Ver disponibilidad', searchButtonWidget: 'Buscar disponibilidad', searching: 'Buscando…',
      dateError: 'La salida debe ser posterior a la llegada',
      noAvailabilityTitle: 'Sin disponibilidad', noAvailabilitySub: 'Prueba con otras fechas o menos personas.',
      availableRooms: 'Habitaciones disponibles',
      roomAvailCount: '{{n}} habitación{{s}} disponible{{s}} · Máx. {{max}} personas',
      cartTitle: 'Tu selección', selectRate: 'Selecciona tarifa:', minStayTag: 'Mín. {{n}} noches', continue: 'Continuar →',
      offer2Nights: '¡Tarifa especial para 2 noches!', offerWeekly: '¡Oferta semanal disponible!', offerMonthly: '¡Tarifa mensual con el mejor precio!',
      optionalServices: 'Servicios opcionales', guestDataTitle: 'Datos del huésped principal',
      firstName: 'Nombre *', lastName: 'Apellidos *', email: 'Email *', phone: 'Teléfono', notes: 'Comentarios',
      notesPlaceholder: 'Cama supletoria, llegada tarde…',
      twinBeds: 'Prefiero dos camas separadas', twinBedsHint: 'Es una preferencia, sujeta a disponibilidad — no la podemos garantizar.',
      requiredFieldsError: 'Nombre, apellidos y email son obligatorios', checkoutError: 'Error al crear la reserva',
      discountCountdown: '¡Oferta relámpago! Completa tu reserva en {{time}} y ahorra un {{pct}}%',
      discountApplied: 'Descuento del {{pct}}% aplicado: -{{amount}}',
      pendingTitle: 'Tienes una reserva pendiente de pago', pendingNotFound: 'Esta reserva pendiente ya no está disponible.',
      pendingBannerText: 'Reserva iniciada — completa el pago para confirmarla.',
      startOver: 'Empezar de nuevo', completePayment: 'Completar pago',
      payButton: 'Pagar {{total}} →',
      successTitle: '¡Reserva confirmada!', successEmailSent: 'Te hemos enviado un email de confirmación.',
      successInfo: 'Reserva #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: 'Ver mis reservas',
    },
  },
  en: {
    common: {
      back: '← Back', total: 'Total', processing: 'Processing…', redirecting: 'Redirecting…',
      nightOne: 'night', nightOther: 'nights', personOne: 'guest', personOther: 'guests',
      perNight: '/night', perPerson: '/guest', perPersonNight: '/guest/night', genericError: 'Error',
    },
    booking: {
      pageTitle: 'Book your stay', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← Back to website', myBookings: 'My bookings',
      stepAvailability: 'Availability', stepGuestData: 'Your details', stepPayment: 'Payment',
      whenTitle: 'When would you like to come?', arrival: 'Check-in', departure: 'Check-out',
      guestsSelectLabel: 'Guests', guestsStepperLabel: 'Guests',
      searchButton: 'Check availability', searchButtonWidget: 'Check availability', searching: 'Searching…',
      dateError: 'Check-out must be after check-in',
      noAvailabilityTitle: 'No availability', noAvailabilitySub: 'Try different dates or fewer guests.',
      availableRooms: 'Available rooms',
      roomAvailCount: '{{n}} room{{s}} available · Max. {{max}} guests',
      cartTitle: 'Your selection', selectRate: 'Select a rate:', minStayTag: 'Min. {{n}} nights', continue: 'Continue →',
      offer2Nights: 'Special rate for 2 nights!', offerWeekly: 'Weekly offer available!', offerMonthly: 'Monthly rate with the best price!',
      optionalServices: 'Optional services', guestDataTitle: 'Main guest details',
      firstName: 'First name *', lastName: 'Last name *', email: 'Email *', phone: 'Phone', notes: 'Comments',
      notesPlaceholder: 'Extra bed, late arrival…',
      twinBeds: 'I prefer two separate beds', twinBedsHint: "This is a preference, subject to availability — we can't guarantee it.",
      requiredFieldsError: 'First name, last name and email are required', checkoutError: 'Error creating the booking',
      discountCountdown: 'Flash offer! Complete your booking within {{time}} and save {{pct}}%',
      discountApplied: '{{pct}}% discount applied: -{{amount}}',
      pendingTitle: 'You have a pending reservation', pendingNotFound: 'This pending reservation is no longer available.',
      pendingBannerText: 'Booking started — complete payment to confirm it.',
      startOver: 'Start over', completePayment: 'Complete payment',
      payButton: 'Pay {{total}} →',
      successTitle: 'Booking confirmed!', successEmailSent: "We've sent you a confirmation email.",
      successInfo: 'Booking #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: 'View my bookings',
    },
  },
  fr: {
    common: {
      back: '← Retour', total: 'Total', processing: 'Traitement…', redirecting: 'Redirection…',
      nightOne: 'nuit', nightOther: 'nuits', personOne: 'personne', personOther: 'personnes',
      perNight: '/nuit', perPerson: '/personne', perPersonNight: '/personne/nuit', genericError: 'Erreur',
    },
    booking: {
      pageTitle: 'Réservez votre séjour', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← Retour au site', myBookings: 'Mes réservations',
      stepAvailability: 'Disponibilité', stepGuestData: 'Vos informations', stepPayment: 'Paiement',
      whenTitle: 'Quand souhaitez-vous venir ?', arrival: 'Arrivée', departure: 'Départ',
      guestsSelectLabel: 'Personnes', guestsStepperLabel: 'Voyageurs',
      searchButton: 'Voir les disponibilités', searchButtonWidget: 'Vérifier les disponibilités', searching: 'Recherche…',
      dateError: 'Le départ doit être après l\'arrivée',
      noAvailabilityTitle: 'Aucune disponibilité', noAvailabilitySub: 'Essayez d\'autres dates ou moins de personnes.',
      availableRooms: 'Chambres disponibles',
      roomAvailCount: '{{n}} chambre{{s}} disponible{{s}} · Max. {{max}} personnes',
      cartTitle: 'Votre sélection', selectRate: 'Choisissez un tarif :', minStayTag: 'Min. {{n}} nuits', continue: 'Continuer →',
      offer2Nights: 'Tarif spécial pour 2 nuits !', offerWeekly: 'Offre hebdomadaire disponible !', offerMonthly: 'Tarif mensuel au meilleur prix !',
      optionalServices: 'Services optionnels', guestDataTitle: 'Coordonnées du client principal',
      firstName: 'Prénom *', lastName: 'Nom *', email: 'Email *', phone: 'Téléphone', notes: 'Commentaires',
      notesPlaceholder: 'Lit supplémentaire, arrivée tardive…',
      twinBeds: 'Je préfère deux lits séparés', twinBedsHint: 'Il s\'agit d\'une préférence, sous réserve de disponibilité — nous ne pouvons pas la garantir.',
      requiredFieldsError: 'Le prénom, le nom et l\'email sont obligatoires', checkoutError: 'Erreur lors de la création de la réservation',
      discountCountdown: 'Offre flash ! Terminez votre réservation en {{time}} et économisez {{pct}}%',
      discountApplied: 'Réduction de {{pct}}% appliquée : -{{amount}}',
      pendingTitle: 'Vous avez une réservation en attente', pendingNotFound: "Cette réservation en attente n'est plus disponible.",
      pendingBannerText: 'Réservation commencée — terminez le paiement pour la confirmer.',
      startOver: 'Recommencer', completePayment: 'Terminer le paiement',
      payButton: 'Payer {{total}} →',
      successTitle: 'Réservation confirmée !', successEmailSent: 'Nous vous avons envoyé un email de confirmation.',
      successInfo: 'Réservation #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: 'Voir mes réservations',
    },
  },
  de: {
    common: {
      back: '← Zurück', total: 'Gesamt', processing: 'Wird bearbeitet…', redirecting: 'Weiterleitung…',
      nightOne: 'Nacht', nightOther: 'Nächte', personOne: 'Person', personOther: 'Personen',
      perNight: '/Nacht', perPerson: '/Person', perPersonNight: '/Person/Nacht', genericError: 'Fehler',
    },
    booking: {
      pageTitle: 'Buchen Sie Ihren Aufenthalt', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← Zurück zur Website', myBookings: 'Meine Buchungen',
      stepAvailability: 'Verfügbarkeit', stepGuestData: 'Ihre Daten', stepPayment: 'Zahlung',
      whenTitle: 'Wann möchten Sie kommen?', arrival: 'Anreise', departure: 'Abreise',
      guestsSelectLabel: 'Personen', guestsStepperLabel: 'Gäste',
      searchButton: 'Verfügbarkeit prüfen', searchButtonWidget: 'Verfügbarkeit prüfen', searching: 'Suche läuft…',
      dateError: 'Die Abreise muss nach der Anreise liegen',
      noAvailabilityTitle: 'Keine Verfügbarkeit', noAvailabilitySub: 'Versuchen Sie andere Daten oder weniger Personen.',
      availableRooms: 'Verfügbare Zimmer',
      roomAvailCount: '{{n}} Zimmer verfügbar · Max. {{max}} Personen',
      cartTitle: 'Ihre Auswahl', selectRate: 'Tarif auswählen:', minStayTag: 'Min. {{n}} Nächte', continue: 'Weiter →',
      offer2Nights: 'Sonderpreis für 2 Nächte!', offerWeekly: 'Wochenangebot verfügbar!', offerMonthly: 'Monatstarif zum besten Preis!',
      optionalServices: 'Zusätzliche Leistungen', guestDataTitle: 'Daten des Hauptgastes',
      firstName: 'Vorname *', lastName: 'Nachname *', email: 'E-Mail *', phone: 'Telefon', notes: 'Kommentare',
      notesPlaceholder: 'Zustellbett, späte Ankunft…',
      twinBeds: 'Ich bevorzuge zwei getrennte Betten', twinBedsHint: 'Dies ist ein Wunsch, abhängig von der Verfügbarkeit — wir können ihn nicht garantieren.',
      requiredFieldsError: 'Vorname, Nachname und E-Mail sind erforderlich', checkoutError: 'Fehler beim Erstellen der Buchung',
      discountCountdown: 'Blitzangebot! Schließen Sie Ihre Buchung innerhalb von {{time}} ab und sparen Sie {{pct}}%',
      discountApplied: '{{pct}}% Rabatt angewendet: -{{amount}}',
      pendingTitle: 'Sie haben eine ausstehende Buchung', pendingNotFound: 'Diese ausstehende Buchung ist nicht mehr verfügbar.',
      pendingBannerText: 'Buchung begonnen — schließen Sie die Zahlung ab, um sie zu bestätigen.',
      startOver: 'Von vorne beginnen', completePayment: 'Zahlung abschließen',
      payButton: '{{total}} bezahlen →',
      successTitle: 'Buchung bestätigt!', successEmailSent: 'Wir haben Ihnen eine Bestätigungs-E-Mail gesendet.',
      successInfo: 'Buchung #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: 'Meine Buchungen ansehen',
    },
  },
  it: {
    common: {
      back: '← Indietro', total: 'Totale', processing: 'Elaborazione…', redirecting: 'Reindirizzamento…',
      nightOne: 'notte', nightOther: 'notti', personOne: 'persona', personOther: 'persone',
      perNight: '/notte', perPerson: '/persona', perPersonNight: '/persona/notte', genericError: 'Errore',
    },
    booking: {
      pageTitle: 'Prenota il tuo soggiorno', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← Torna al sito', myBookings: 'Le mie prenotazioni',
      stepAvailability: 'Disponibilità', stepGuestData: 'I tuoi dati', stepPayment: 'Pagamento',
      whenTitle: 'Quando vuoi venire?', arrival: 'Arrivo', departure: 'Partenza',
      guestsSelectLabel: 'Persone', guestsStepperLabel: 'Ospiti',
      searchButton: 'Verifica disponibilità', searchButtonWidget: 'Verifica disponibilità', searching: 'Ricerca…',
      dateError: 'La partenza deve essere successiva all\'arrivo',
      noAvailabilityTitle: 'Nessuna disponibilità', noAvailabilitySub: 'Prova con altre date o meno persone.',
      availableRooms: 'Camere disponibili',
      roomAvailCount: '{{n}} camera/e disponibile/i · Max. {{max}} persone',
      cartTitle: 'La tua selezione', selectRate: 'Seleziona una tariffa:', minStayTag: 'Min. {{n}} notti', continue: 'Continua →',
      offer2Nights: 'Tariffa speciale per 2 notti!', offerWeekly: 'Offerta settimanale disponibile!', offerMonthly: 'Tariffa mensile al miglior prezzo!',
      optionalServices: 'Servizi opzionali', guestDataTitle: 'Dati dell\'ospite principale',
      firstName: 'Nome *', lastName: 'Cognome *', email: 'Email *', phone: 'Telefono', notes: 'Commenti',
      notesPlaceholder: 'Letto aggiuntivo, arrivo tardivo…',
      twinBeds: 'Preferisco due letti separati', twinBedsHint: 'È una preferenza, soggetta a disponibilità — non possiamo garantirla.',
      requiredFieldsError: 'Nome, cognome ed email sono obbligatori', checkoutError: 'Errore nella creazione della prenotazione',
      discountCountdown: 'Offerta lampo! Completa la tua prenotazione entro {{time}} e risparmia il {{pct}}%',
      discountApplied: 'Sconto del {{pct}}% applicato: -{{amount}}',
      pendingTitle: 'Hai una prenotazione in sospeso', pendingNotFound: 'Questa prenotazione in sospeso non è più disponibile.',
      pendingBannerText: 'Prenotazione iniziata — completa il pagamento per confermarla.',
      startOver: 'Ricomincia', completePayment: 'Completa il pagamento',
      payButton: 'Paga {{total}} →',
      successTitle: 'Prenotazione confermata!', successEmailSent: 'Ti abbiamo inviato un\'email di conferma.',
      successInfo: 'Prenotazione #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: 'Vedi le mie prenotazioni',
    },
  },
  uk: {
    common: {
      back: '← Назад', total: 'Разом', processing: 'Обробка…', redirecting: 'Перенаправлення…',
      nightOne: 'ніч', nightOther: 'ночей', personOne: 'особа', personOther: 'осіб',
      perNight: '/ніч', perPerson: '/особу', perPersonNight: '/особу/ніч', genericError: 'Помилка',
    },
    booking: {
      pageTitle: 'Забронюйте проживання', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← На сайт', myBookings: 'Мої бронювання',
      stepAvailability: 'Наявність', stepGuestData: 'Ваші дані', stepPayment: 'Оплата',
      whenTitle: 'Коли ви хочете приїхати?', arrival: 'Заїзд', departure: 'Виїзд',
      guestsSelectLabel: 'Гості', guestsStepperLabel: 'Гості',
      searchButton: 'Перевірити наявність', searchButtonWidget: 'Перевірити наявність', searching: 'Пошук…',
      dateError: 'Дата виїзду має бути пізніше дати заїзду',
      noAvailabilityTitle: 'Немає вільних номерів', noAvailabilitySub: 'Спробуйте інші дати або менше гостей.',
      availableRooms: 'Доступні номери',
      roomAvailCount: 'Доступно номерів: {{n}} · Макс. {{max}} гостей',
      cartTitle: 'Ваш вибір', selectRate: 'Оберіть тариф:', minStayTag: 'Мін. {{n}} ночей', continue: 'Продовжити →',
      offer2Nights: 'Спеціальний тариф на 2 ночі!', offerWeekly: 'Доступна тижнева пропозиція!', offerMonthly: 'Місячний тариф за найкращою ціною!',
      optionalServices: 'Додаткові послуги', guestDataTitle: 'Дані основного гостя',
      firstName: "Ім'я *", lastName: 'Прізвище *', email: 'Email *', phone: 'Телефон', notes: 'Коментарі',
      notesPlaceholder: 'Додаткове ліжко, пізнє прибуття…',
      twinBeds: 'Я віддаю перевагу двом окремим ліжкам', twinBedsHint: 'Це побажання, залежить від наявності — ми не можемо його гарантувати.',
      requiredFieldsError: "Ім'я, прізвище та email є обов'язковими", checkoutError: 'Помилка при створенні бронювання',
      discountCountdown: 'Блискавична пропозиція! Завершіть бронювання протягом {{time}} і заощадьте {{pct}}%',
      discountApplied: 'Знижку {{pct}}% застосовано: -{{amount}}',
      pendingTitle: 'У вас є незавершене бронювання', pendingNotFound: 'Це незавершене бронювання більше недоступне.',
      pendingBannerText: 'Бронювання розпочато — завершіть оплату, щоб підтвердити його.',
      startOver: 'Почати спочатку', completePayment: 'Завершити оплату',
      payButton: 'Оплатити {{total}} →',
      successTitle: 'Бронювання підтверджено!', successEmailSent: 'Ми надіслали вам електронний лист із підтвердженням.',
      successInfo: 'Бронювання #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: 'Переглянути мої бронювання',
    },
  },
  zh: {
    common: {
      back: '← 返回', total: '总计', processing: '处理中…', redirecting: '正在跳转…',
      nightOne: '晚', nightOther: '晚', personOne: '位', personOther: '位',
      perNight: '/晚', perPerson: '/人', perPersonNight: '/人/晚', genericError: '错误',
    },
    booking: {
      pageTitle: '预订您的住宿', pageSub: '{{hotel}} · {{location}}',
      backToSite: '← 返回网站', myBookings: '我的预订',
      stepAvailability: '查看空房', stepGuestData: '您的信息', stepPayment: '付款',
      whenTitle: '您想什么时候入住？', arrival: '入住', departure: '退房',
      guestsSelectLabel: '人数', guestsStepperLabel: '人数',
      searchButton: '查看空房', searchButtonWidget: '查看空房', searching: '搜索中…',
      dateError: '退房日期必须晚于入住日期',
      noAvailabilityTitle: '暂无空房', noAvailabilitySub: '请尝试其他日期或减少入住人数。',
      availableRooms: '可预订房间',
      roomAvailCount: '{{n}} 间可预订房间 · 最多 {{max}} 人',
      cartTitle: '您的选择', selectRate: '选择价格方案：', minStayTag: '最短 {{n}} 晚', continue: '继续 →',
      offer2Nights: '连住2晚特惠价！', offerWeekly: '每周特惠已开放！', offerMonthly: '超值月付价格！',
      optionalServices: '可选服务', guestDataTitle: '主要入住人信息',
      firstName: '名字 *', lastName: '姓氏 *', email: '邮箱 *', phone: '电话', notes: '备注',
      notesPlaceholder: '加床、晚到…',
      twinBeds: '我希望使用两张单人床', twinBedsHint: '这只是一个偏好，视房间供应情况而定——我们无法保证。',
      requiredFieldsError: '名字、姓氏和邮箱为必填项', checkoutError: '创建预订时出错',
      discountCountdown: '限时优惠！在{{time}}内完成预订，节省{{pct}}%',
      discountApplied: '已应用{{pct}}%折扣：-{{amount}}',
      pendingTitle: '您有一个待付款的预订', pendingNotFound: '该待付款预订已不可用。',
      pendingBannerText: '预订已开始 — 完成付款以确认。',
      startOver: '重新开始', completePayment: '完成付款',
      payButton: '支付 {{total}} →',
      successTitle: '预订已确认！', successEmailSent: '我们已向您发送确认邮件。',
      successInfo: '预订 #{{id}} · {{checkIn}} → {{checkOut}}', viewMyBookings: '查看我的预订',
    },
  },
}
