// Modal de check-in — recoge los datos del huésped requeridos para partes de viajeros
// Uso: import { openCheckInModal } from '../checkin-modal.js'
//      await openCheckInModal(reservationId, onSuccess)

import { api } from './api.js'
import { modal, showToast } from './helpers.js'

const DOC_TYPES = [
  { value: 'dni',              label: 'DNI' },
  { value: 'nie',              label: 'NIE' },
  { value: 'passport',         label: 'Pasaporte' },
  { value: 'driving_licence',  label: 'Permiso de conducir' },
  { value: 'other',            label: 'Otro' },
]

const GENDERS = [
  { value: 'unspecified', label: 'No especificado' },
  { value: 'male',        label: 'Hombre' },
  { value: 'female',      label: 'Mujer' },
]

function field(id, label, type = 'text', opts = {}) {
  const required  = opts.required ? ' *' : ''
  const value     = opts.value ?? ''
  const fullClass = opts.full ? ' full' : ''
  const ph        = opts.placeholder ?? ''
  return `
    <div class="form-group${fullClass}">
      <label>${label}${required}</label>
      <input type="${type}" id="${id}" value="${value}" placeholder="${ph}"${opts.required ? ' required' : ''}>
    </div>`
}

function select(id, label, options, current, opts = {}) {
  const required  = opts.required ? ' *' : ''
  const fullClass = opts.full ? ' full' : ''
  return `
    <div class="form-group${fullClass}">
      <label>${label}${required}</label>
      <select id="${id}"${opts.required ? ' required' : ''}>
        <option value="">—</option>
        ${options.map(o => `<option value="${o.value}"${current === o.value ? ' selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>`
}

export async function openCheckInModal(reservationId, onSuccess) {
  // Cargar reserva + huésped actuales
  let reservation, guest
  try {
    const { data } = await api.getReservation(reservationId)
    reservation = data
    guest = data.guest ?? {}
  } catch (err) {
    showToast('Error cargando la reserva', 'err')
    return
  }

  const guestName = `${guest.firstName ?? ''} ${guest.lastName ?? ''}`.trim()

  const m = modal(`Check-in — ${guestName || 'Huésped'}`, `
    <p style="color:var(--text2);font-size:12px;margin-bottom:12px">
      Hab. <strong style="color:var(--text)">${reservation.room?.code ?? '—'}</strong> ·
      ${reservation.checkInDate} → ${reservation.checkOutDate} ·
      ${reservation.nights} noche${reservation.nights !== 1 ? 's' : ''}
    </p>

    <div class="checkin-sections">

      <div class="checkin-section">
        <div class="checkin-section-title">Datos personales</div>
        <div class="form-grid">
          ${field('ci-fn',    'Nombre *',    'text', { value: guest.firstName ?? '', required: true })}
          ${field('ci-ln',    'Apellidos *', 'text', { value: guest.lastName  ?? '', required: true })}
          ${field('ci-ln2',   'Segundo apellido', 'text', { value: guest.secondLastName ?? '' })}
          ${select('ci-gender', 'Sexo', GENDERS, guest.gender ?? 'unspecified')}
          ${field('ci-dob',   'Fecha nacimiento', 'date', { value: guest.dateOfBirth ?? '' })}
          ${field('ci-nat',   'Nacionalidad',    'text', { value: guest.nationality ?? '', placeholder: 'Ej: España, Germany…' })}
          ${field('ci-phone', 'Teléfono',        'tel',  { value: guest.phone ?? '' })}
          ${field('ci-email', 'Email',           'email',{ value: guest.email ?? '' })}
        </div>
      </div>

      <div class="checkin-section">
        <div class="checkin-section-title">Documento de identidad <span style="font-size:11px;color:var(--text2)">(requerido para partes de viajeros)</span></div>
        <div class="form-grid">
          ${select('ci-doctype', 'Tipo documento', DOC_TYPES, guest.idDocType ?? '')}
          ${field('ci-docnum',     'Número documento', 'text', { value: guest.idDocNumber ?? '' })}
          ${field('ci-docsupport', 'Nº soporte (DNI/NIE)', 'text', { value: guest.idDocSupportNumber ?? '' })}
          ${field('ci-docissuer',  'País expedición',     'text', { value: guest.idDocIssuer ?? '', placeholder: 'Ej: España' })}
          ${field('ci-docexpiry',  'Fecha caducidad',     'date', { value: guest.idDocExpiryDate ?? '' })}
        </div>
      </div>

      <div class="checkin-section">
        <div class="checkin-section-title">Dirección</div>
        <div class="form-grid">
          ${field('ci-addr',    'Dirección',      'text', { value: guest.address1 ?? '', full: true })}
          ${field('ci-zip',     'Código postal',  'text', { value: guest.zipCode  ?? '' })}
          ${field('ci-city',    'Ciudad',         'text', { value: guest.city     ?? '' })}
        </div>
      </div>

      <div class="checkin-section">
        <div class="checkin-section-title">Estancia</div>
        <div class="form-grid">
          ${field('ci-people', 'Personas', 'number', { value: reservation.people ?? 1 })}
          <div class="form-group">
            <label>Motivo estancia</label>
            <select id="ci-purpose">
              <option value="">—</option>
              ${['Turismo','Negocios','Estudios','Salud','Tránsito','Otro'].map(p =>
                `<option value="${p}"${guest.purposeOfStay === p ? ' selected' : ''}>${p}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      </div>

    </div>`,
    `<button class="btn btn-ghost" data-close>Cancelar</button>
     <button class="btn btn-primary" id="ci-confirm">Confirmar check-in</button>`,
    { wide: true }
  )

  m.querySelector('#ci-confirm').onclick = async () => {
    const get = id => m.querySelector(`#${id}`)?.value?.trim() ?? ''

    const firstName = get('ci-fn')
    const lastName  = get('ci-ln')
    if (!firstName || !lastName) {
      showToast('Nombre y apellidos son obligatorios', 'err')
      return
    }

    const btn = m.querySelector('#ci-confirm')
    btn.disabled = true
    btn.textContent = 'Guardando…'

    try {
      await api.checkIn(reservationId, {
        firstName,
        lastName,
        secondLastName:     get('ci-ln2')     || undefined,
        gender:             get('ci-gender')  || undefined,
        dateOfBirth:        get('ci-dob')     || undefined,
        nationality:        get('ci-nat')     || undefined,
        phone:              get('ci-phone')   || undefined,
        email:              get('ci-email')   || undefined,
        idDocType:          get('ci-doctype') || undefined,
        idDocNumber:        get('ci-docnum')  || undefined,
        idDocSupportNumber: get('ci-docsupport') || undefined,
        idDocIssuer:        get('ci-docissuer')  || undefined,
        idDocExpiryDate:    get('ci-docexpiry')  || undefined,
        address1:           get('ci-addr')    || undefined,
        zipCode:            get('ci-zip')     || undefined,
        city:               get('ci-city')    || undefined,
        people:             parseInt(get('ci-people')) || undefined,
        purposeOfStay:      get('ci-purpose') || undefined,
      })
      m.remove()
      showToast('Check-in realizado')
      if (onSuccess) onSuccess()
    } catch (err) {
      showToast(err.message, 'err')
      btn.disabled = false
      btn.textContent = 'Confirmar check-in'
    }
  }
}
