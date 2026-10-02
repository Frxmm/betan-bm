import { api } from '../api.js'
import { fmtDate, loading, empty, showToast, modal } from '../helpers.js'

export async function renderGuests(container) {
  container.innerHTML = `
    <div class="search-bar">
      <input id="guest-search" placeholder="Buscar por nombre, email, documento…" type="search" style="max-width:400px">
      <button class="btn btn-primary" id="btn-new-guest">+ Nuevo huésped</button>
    </div>
    <div id="guest-table-wrap">${loading()}</div>`

  document.getElementById('guest-search').oninput = debounce(loadGuests, 350)
  document.getElementById('btn-new-guest').onclick = () => showGuestModal(null, container)

  await loadGuests()
}

async function loadGuests() {
  const wrap = document.getElementById('guest-table-wrap')
  if (!wrap) return
  wrap.innerHTML = loading()
  const q = document.getElementById('guest-search')?.value?.trim()
  try {
    const { data, meta } = await api.listGuests({ q: q || undefined, limit: 100 })
    if (!data.length) { wrap.innerHTML = empty('Sin huéspedes'); return }
    wrap.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>Huéspedes <span style="color:var(--text2);font-weight:400">(${meta.total})</span></h2></div>
        <table>
          <thead><tr><th>Nombre</th><th>Email</th><th>Teléfono</th><th>Documento</th><th>VIP</th><th>Alta</th></tr></thead>
          <tbody>
            ${data.map(g => `
              <tr onclick="showGuestModalById(${g.id})">
                <td><strong>${g.firstName} ${g.lastName}</strong>${g.secondLastName ? ` ${g.secondLastName}` : ''}</td>
                <td>${g.email ?? '—'}</td>
                <td>${g.phone ?? '—'}</td>
                <td>${g.idDocType ? `${g.idDocType.toUpperCase()} ${g.idDocNumber ?? ''}` : '—'}</td>
                <td>${g.isVip ? '★' : ''}</td>
                <td style="color:var(--text2);font-size:12px">${fmtDate(g.createdAt)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

export function showGuestModal(guest, container) {
  const g = guest ?? {}
  const isEdit = !!g.id
  const m = modal(isEdit ? 'Editar huésped' : 'Nuevo huésped', `
    <div class="form-grid">
      <div class="form-group">
        <label>Nombre *</label>
        <input id="g-fname" value="${g.firstName ?? ''}" required>
      </div>
      <div class="form-group">
        <label>Apellido 1 *</label>
        <input id="g-lname" value="${g.lastName ?? ''}" required>
      </div>
      <div class="form-group">
        <label>Apellido 2</label>
        <input id="g-lname2" value="${g.secondLastName ?? ''}">
      </div>
      <div class="form-group">
        <label>Género</label>
        <select id="g-gender">
          <option value="unspecified" ${g.gender==='unspecified'?'selected':''}>Sin especificar</option>
          <option value="male" ${g.gender==='male'?'selected':''}>Masculino</option>
          <option value="female" ${g.gender==='female'?'selected':''}>Femenino</option>
          <option value="non_binary" ${g.gender==='non_binary'?'selected':''}>No binario</option>
        </select>
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="g-email" value="${g.email ?? ''}">
      </div>
      <div class="form-group">
        <label>Teléfono</label>
        <input id="g-phone" value="${g.phone ?? ''}">
      </div>
      <div class="form-group">
        <label>Tipo de documento</label>
        <select id="g-doctype">
          <option value="">Sin documento</option>
          <option value="dni"  ${g.idDocType==='dni'?'selected':''}>DNI</option>
          <option value="nie"  ${g.idDocType==='nie'?'selected':''}>NIE</option>
          <option value="passport" ${g.idDocType==='passport'?'selected':''}>Pasaporte</option>
          <option value="driving_licence" ${g.idDocType==='driving_licence'?'selected':''}>Carnet conducir</option>
          <option value="other" ${g.idDocType==='other'?'selected':''}>Otro</option>
        </select>
      </div>
      <div class="form-group">
        <label>Número de documento</label>
        <input id="g-docnum" value="${g.idDocNumber ?? ''}">
      </div>
      <div class="form-group">
        <label>Código soporte (DNI/NIE)</label>
        <input id="g-docsupport" value="${g.idDocSupportNumber ?? ''}">
      </div>
      <div class="form-group">
        <label>Ciudad</label>
        <input id="g-city" value="${g.city ?? ''}">
      </div>
      <div class="form-group" style="display:flex;flex-direction:row;align-items:center;gap:8px;padding-top:20px">
        <input type="checkbox" id="g-vip" ${g.isVip?'checked':''}>
        <label for="g-vip">Marcar como VIP</label>
      </div>
      <div class="form-group" style="display:flex;flex-direction:row;align-items:center;gap:8px;padding-top:20px">
        <input type="checkbox" id="g-consent" ${g.emailConsentGiven?'checked':''}>
        <label for="g-consent">Consentimiento email (RGPD)</label>
      </div>
    </div>`,
    `<button class="btn btn-ghost" data-close>Cancelar</button>
     <button class="btn btn-primary" id="btn-save-guest">${isEdit ? 'Guardar' : 'Crear'}</button>`
  )

  m.querySelector('#btn-save-guest').onclick = async () => {
    const data = {
      firstName:          m.querySelector('#g-fname').value.trim(),
      lastName:           m.querySelector('#g-lname').value.trim(),
      secondLastName:     m.querySelector('#g-lname2').value.trim() || undefined,
      gender:             m.querySelector('#g-gender').value,
      email:              m.querySelector('#g-email').value.trim() || undefined,
      phone:              m.querySelector('#g-phone').value.trim() || undefined,
      idDocType:          m.querySelector('#g-doctype').value || undefined,
      idDocNumber:        m.querySelector('#g-docnum').value.trim() || undefined,
      idDocSupportNumber: m.querySelector('#g-docsupport').value.trim() || undefined,
      city:               m.querySelector('#g-city').value.trim() || undefined,
      isVip:              m.querySelector('#g-vip').checked,
      emailConsentGiven:  m.querySelector('#g-consent').checked,
    }
    if (!data.firstName || !data.lastName) { showToast('Nombre y apellido son obligatorios', 'err'); return }
    try {
      if (isEdit) {
        await api.updateGuest(g.id, data)
        showToast('Huésped actualizado')
      } else {
        await api.createGuest(data)
        showToast('Huésped creado')
      }
      m.remove()
      await loadGuests()
    } catch (err) { showToast(err.message, 'err') }
  }
}

window.showGuestModalById = async (id) => {
  try {
    const { data } = await api.getGuest(id)
    showGuestModal(data)
  } catch (err) { showToast(err.message, 'err') }
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}
