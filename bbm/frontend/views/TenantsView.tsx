// Administración de tenants (solo administradores de plataforma): alta con asistente,
// edición por pestañas, "entrar como" (soporte) y activar/desactivar.
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Modal } from '../components/Modal'
import { api, type TenantModule } from '../lib/api'
import { toast } from '../lib/utils'
import { useProperty } from '../contexts/PropertyContext'

type Modules = Record<string, TenantModule>
type Meta = { features: string[]; defaultOn: string[]; modules: Modules }

const GROUP_ORDER = ['Ventas', 'Distribución', 'Revenue', 'Operaciones', 'Comunicación']

function groupModules(meta: Meta) {
  const groups: Record<string, string[]> = {}
  for (const k of meta.features) (groups[meta.modules[k]!.group] ??= []).push(k)
  return Object.entries(groups).sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
}

const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—'

// ─── Banner de sesión de soporte (se monta en App.tsx) ────────────────────────
export function ImpersonationBanner() {
  const { property } = useProperty()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!property.impersonating) return
    const prev = document.body.style.paddingBottom
    document.body.style.paddingBottom = '40px'
    return () => { document.body.style.paddingBottom = prev }
  }, [property.impersonating])
  if (!property.impersonating) return null
  const exit = async () => {
    setBusy(true)
    try { await api.stopImpersonation(); window.location.href = '/tenants' }
    catch (e: any) { toast(e.message, 'err'); setBusy(false) }
  }
  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 9000, height: 40,
      background: '#f59e0b', color: '#000', display: 'flex', alignItems: 'center',
      justifyContent: 'center', gap: 14, fontSize: 13, fontWeight: 700,
    }}>
      <span>🛟 Sesión de soporte: estás dentro de «{property.name}» como administrador de plataforma</span>
      <button className="btn btn-xs" onClick={exit} disabled={busy} style={{ background: '#000', color: '#fff', border: 'none' }}>
        Salir de la sesión de soporte
      </button>
    </div>
  )
}

// ─── Campos reutilizables ─────────────────────────────────────────────────────
function Field({ label, value, onChange, type = 'text', placeholder, hint, autoComplete }: {
  label: string; value: string; onChange: (v: string) => void; type?: string
  placeholder?: string; hint?: string; autoComplete?: string
}) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete} />
      {hint && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

const EMPTY_FORM = {
  slug: '', name: '', legalName: '', vatNumber: '', touristRegistryNumber: '', address: '', postalCode: '',
  city: '', region: '', countryCode: 'ES', currencyCode: 'EUR', timezone: 'Europe/Madrid', localeDefault: 'es', starLabel: '',
  phone: '', email: '', receptionEmail: '', fromEmail: '', websiteUrl: '', publicDomain: '', mapsUrl: '', logoUrl: '',
}
type Form = typeof EMPTY_FORM

function IdentityFields({ f, set, isNew }: { f: Form; set: (k: keyof Form) => (v: string) => void; isNew?: boolean }) {
  return (
    <div className="form-grid">
      {isNew && <Field label="Slug * (a-z, 0-9, guiones)" value={f.slug} onChange={v => set('slug')(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="hotel-mar" hint="Identificador único; también prefijo de plantillas." />}
      <Field label="Nombre comercial *" value={f.name} onChange={set('name')} />
      <Field label="Razón social" value={f.legalName} onChange={set('legalName')} />
      <Field label="CIF / NIF" value={f.vatNumber} onChange={set('vatNumber')} />
      <Field label="Nº registro de turismo" value={f.touristRegistryNumber} onChange={set('touristRegistryNumber')} />
      <Field label="Categoría (estrellas)" value={f.starLabel} onChange={set('starLabel')} placeholder="★★★" />
      <Field label="Dirección" value={f.address} onChange={set('address')} />
      <Field label="Código postal" value={f.postalCode} onChange={set('postalCode')} />
      <Field label="Ciudad" value={f.city} onChange={set('city')} />
      <Field label="Provincia / región" value={f.region} onChange={set('region')} />
      <Field label="País (ISO 2)" value={f.countryCode} onChange={v => set('countryCode')(v.toUpperCase().slice(0, 2))} />
      <Field label="Moneda (ISO 3)" value={f.currencyCode} onChange={v => set('currencyCode')(v.toUpperCase().slice(0, 3))} />
      <Field label="Zona horaria" value={f.timezone} onChange={set('timezone')} placeholder="Europe/Madrid" />
      <Field label="Idioma por defecto" value={f.localeDefault} onChange={set('localeDefault')} />
    </div>
  )
}

function ContactFields({ f, set, platform }: { f: Form; set: (k: keyof Form) => (v: string) => void; platform?: boolean }) {
  return (
    <div className="form-grid">
      <Field label="Teléfono" value={f.phone} onChange={set('phone')} type="tel" />
      <Field label="Email general" value={f.email} onChange={set('email')} type="email" />
      <Field label="Email de recepción" value={f.receptionEmail} onChange={set('receptionEmail')} type="email" hint="Recibe avisos internos." />
      <Field label="Remitente de correos" value={f.fromEmail} onChange={set('fromEmail')} placeholder="Hotel Mar <reservas@hotelmar.com>" hint="Dominio verificado en el proveedor de email." />
      <Field label="Web" value={f.websiteUrl} onChange={set('websiteUrl')} placeholder="https://" />
      {platform && <Field label="Dominio público" value={f.publicDomain} onChange={set('publicDomain')} placeholder="reservas.hotelmar.com" hint="Resuelve motor de reservas y portal por dominio." />}
      <Field label="Enlace de Google Maps" value={f.mapsUrl} onChange={set('mapsUrl')} />
      <Field label="URL del logo" value={f.logoUrl} onChange={set('logoUrl')} />
    </div>
  )
}

function formFrom(t: any): Form {
  const o: any = {}
  for (const k of Object.keys(EMPTY_FORM)) o[k] = t?.[k] ?? (EMPTY_FORM as any)[k]
  return o
}

function ModuleToggles({ meta, value, onChange }: { meta: Meta; value: Record<string, boolean>; onChange: (k: string, v: boolean) => void }) {
  return (
    <>
      {groupModules(meta).map(([group, keys]) => (
        <fieldset key={group} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>{group}</legend>
          <div style={{ display: 'grid', gap: 8 }}>
            {keys.map(k => (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!value[k]} onChange={e => onChange(k, e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  <strong style={{ fontSize: 13 }}>{meta.modules[k]!.label}</strong>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text2)' }}>{meta.modules[k]!.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </>
  )
}

function SecretInputs({ meta, enabled, values, status, onChange }: {
  meta: Meta; enabled: Record<string, boolean>; values: Record<string, string>
  status?: Record<string, any>; onChange: (name: string, v: string) => void
}) {
  const mods = meta.features.filter(k => enabled[k] && meta.modules[k]!.secrets.length > 0)
  if (mods.length === 0) return <p style={{ color: 'var(--text2)', fontSize: 13 }}>Ningún módulo activo necesita credenciales.</p>
  return (
    <>
      {mods.map(k => (
        <fieldset key={k} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <legend style={{ padding: '0 6px', color: 'var(--text2)', fontSize: 12 }}>{meta.modules[k]!.label}</legend>
          <div className="form-grid">
            {meta.modules[k]!.secrets.map(sc => {
              const st = status?.[`secrets.${sc.name}`]
              return (
                <div className="form-group" key={sc.name}>
                  <label>{sc.label} <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text2)' }}>{sc.name}</span></label>
                  <input type="password" autoComplete="new-password" value={values[sc.name] ?? ''}
                    onChange={e => onChange(sc.name, e.target.value)}
                    placeholder={st?.set ? `Configurada ${st.masked} — escribe para reemplazar` : 'Sin configurar'} />
                  {st?.set && <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 2 }}>● Guardada (no se puede ver)</div>}
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}
    </>
  )
}

const secretsPayload = (vals: Record<string, string>) =>
  Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim() !== '').map(([k, v]) => [`secrets.${k}`, v.trim()]))

// ─── Vista principal ──────────────────────────────────────────────────────────
export default function TenantsView() {
  const [tenants, setTenants] = useState<any[] | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [created, setCreated] = useState<any | null>(null)

  const load = useCallback(() => {
    api.listTenants().then(r => setTenants(r.data)).catch(e => { toast(e.message, 'err'); setTenants([]) })
  }, [])
  useEffect(() => { load(); api.tenantModules().then(r => setMeta(r.data)).catch(e => toast(e.message, 'err')) }, [load])

  if (!tenants || !meta) return <div className="loading">Cargando…</div>

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Tenants</h2>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>+ Nuevo tenant</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr><th>Establecimiento</th><th>Slug</th><th>Ciudad</th><th>Módulos activos</th><th>Hab.</th><th>Usuarios</th><th>Estado</th><th></th></tr>
          </thead>
          <tbody>
            {tenants.map(t => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                <td><strong>{t.name}</strong><div style={{ fontSize: 11, color: 'var(--text2)' }}>último acceso: {fmtDate(t.lastLoginAt)}</div></td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.slug}</td>
                <td style={{ fontSize: 13 }}>{t.city || '—'}</td>
                <td style={{ maxWidth: 320 }}>
                  {meta.features.filter(k => t.features[k]).map(k => (
                    <span key={k} style={{ display: 'inline-block', margin: '1px 3px 1px 0', padding: '1px 7px', borderRadius: 10, fontSize: 10, background: 'rgba(79,124,255,.15)', border: '1px solid var(--accent)' }}>
                      {meta.modules[k]!.label}
                    </span>
                  ))}
                </td>
                <td>{t.rooms}</td>
                <td>{t.users}</td>
                <td><span style={{ fontSize: 12, color: t.active ? 'var(--green)' : 'var(--text2)' }}>{t.active ? '● Activo' : '○ Inactivo'}</span></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost btn-xs" onClick={() => setEditing(t.id)}>Editar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tenants.length === 0 && <div className="empty" style={{ padding: 24 }}><p>Sin tenants</p></div>}
      </div>

      {creating && <WizardModal meta={meta} onClose={() => setCreating(false)} onDone={r => { setCreating(false); setCreated(r); load() }} />}
      {editing !== null && <EditModal id={editing} meta={meta} onClose={() => { setEditing(null); load() }} />}
      {created && (
        <Modal title="Tenant creado" onClose={() => setCreated(null)} footer={<button className="btn btn-primary" onClick={() => setCreated(null)}>Entendido</button>}>
          <p><strong>{created.tenant.name}</strong> ({created.tenant.slug}) está listo.</p>
          <p style={{ marginTop: 10 }}>Administrador inicial: <strong>{created.admin.email}</strong></p>
          <div style={{ margin: '10px 0', padding: 10, borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--border)' }}>
            Contraseña temporal: <code style={{ fontSize: 15, userSelect: 'all' }}>{created.admin.tempPassword}</code>
            <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 4 }}>Se muestra solo ahora; no se puede recuperar.</div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text2)' }}>
            {created.admin.resetEmailSent ? 'Se ha enviado además un enlace de restablecimiento de contraseña a su correo.' : 'No se pudo enviar el enlace de restablecimiento por email: comparte la contraseña temporal.'}
          </p>
        </Modal>
      )}
    </>
  )
}

// ─── Asistente de alta ────────────────────────────────────────────────────────
const STEPS = ['Identidad y fiscal', 'Contacto y marca', 'Módulos', 'Credenciales', 'Administrador']

function WizardModal({ meta, onClose, onDone }: { meta: Meta; onClose: () => void; onDone: (r: any) => void }) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [features, setFeatures] = useState<Record<string, boolean>>(() => Object.fromEntries(meta.features.map(k => [k, meta.defaultOn.includes(k)])))
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [admin, setAdmin] = useState({ email: '', firstName: '', lastName: '' })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof Form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const validate = (s: number): string | null => {
    if (s === 0) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.slug) || form.slug.length < 2) return 'El slug es obligatorio (a-z, 0-9 y guiones)'
      if (!form.name.trim()) return 'El nombre es obligatorio'
      if (form.currencyCode.length !== 3) return 'Moneda de 3 letras'
      if (form.countryCode && form.countryCode.length !== 2) return 'País de 2 letras'
    }
    if (s === 4) {
      if (!admin.email.trim() || !admin.firstName.trim() || !admin.lastName.trim()) return 'Completa los datos del administrador'
    }
    return null
  }
  const next = () => { const e = validate(step); if (e) { toast(e, 'err'); return }; setStep(step + 1) }

  const submit = async () => {
    for (const s of [0, 4]) { const e = validate(s); if (e) { toast(e, 'err'); setStep(s); return } }
    setSaving(true)
    try {
      const r = await api.createTenant({ ...form, features, settings: secretsPayload(secrets), admin })
      toast('Tenant creado')
      onDone(r.data)
    } catch (e: any) { toast(e.message, 'err'); setSaving(false) }
  }

  return (
    <Modal title={`Nuevo tenant — ${step + 1}/${STEPS.length}: ${STEPS[step]}`} onClose={onClose} wide footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        {step > 0 && <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>Atrás</button>}
        {step < STEPS.length - 1
          ? <button className="btn btn-primary" onClick={next}>Siguiente</button>
          : <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Creando…' : 'Crear tenant'}</button>}
      </>
    }>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {STEPS.map((s, i) => (
          <span key={s} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 12, background: i === step ? 'var(--accent)' : 'var(--bg3)', color: i === step ? '#fff' : 'var(--text2)' }}>{i + 1}. {s}</span>
        ))}
      </div>
      {step === 0 && <IdentityFields f={form} set={set} isNew />}
      {step === 1 && <ContactFields f={form} set={set} platform />}
      {step === 2 && <ModuleToggles meta={meta} value={features} onChange={(k, v) => setFeatures(f => ({ ...f, [k]: v }))} />}
      {step === 3 && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>Las credenciales son de solo escritura: una vez guardadas no se pueden volver a ver. Puedes dejarlas vacías y rellenarlas después.</p>
          <SecretInputs meta={meta} enabled={features} values={secrets} onChange={(n, v) => setSecrets(s => ({ ...s, [n]: v }))} />
        </>
      )}
      {step === 4 && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>Se creará con rol dirección. Se genera una contraseña temporal y se envía un enlace para que elija la suya.</p>
          <div className="form-grid">
            <Field label="Nombre *" value={admin.firstName} onChange={v => setAdmin(a => ({ ...a, firstName: v }))} />
            <Field label="Apellidos *" value={admin.lastName} onChange={v => setAdmin(a => ({ ...a, lastName: v }))} />
            <Field label="Email *" type="email" value={admin.email} onChange={v => setAdmin(a => ({ ...a, email: v }))} />
          </div>
        </>
      )}
    </Modal>
  )
}

// ─── Edición por pestañas ─────────────────────────────────────────────────────
const TABS = ['Datos', 'Módulos', 'Integraciones', 'Ajustes avanzados', 'Usuarios', 'Auditoría'] as const

function EditModal({ id, meta, onClose }: { id: number; meta: Meta; onClose: () => void }) {
  const [tab, setTab] = useState<typeof TABS[number]>('Datos')
  const [t, setT] = useState<any | null>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [json, setJson] = useState('')
  const [audit, setAudit] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const r = await api.getTenant(id)
    setT(r.data); setForm(formFrom(r.data)); setFeatures(r.data.features)
    const plain = Object.fromEntries(Object.entries(r.data.settings as Record<string, unknown>).filter(([k]) => !k.startsWith('secrets.')))
    setJson(JSON.stringify(plain, null, 2))
  }, [id])
  useEffect(() => { reload().catch(e => { toast(e.message, 'err'); onClose() }) }, [reload])
  useEffect(() => { if (tab === 'Auditoría' && !audit) api.tenantAudit(id).then(r => setAudit(r.data)).catch(e => toast(e.message, 'err')) }, [tab])

  const set = (k: keyof Form) => (v: string) => setForm(f => ({ ...f, [k]: v }))
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); await reload(); setAudit(null) } catch (e: any) { toast(e.message, 'err') }
    finally { setBusy(false) }
  }

  const impersonate = async () => {
    if (!confirm(`Entrarás como administrador en «${t.name}» durante 2 horas. La acción queda auditada. ¿Continuar?`)) return
    try { await api.impersonateTenant(id); window.location.href = '/dashboard' }
    catch (e: any) { toast(e.message, 'err') }
  }
  const toggleActive = async () => {
    const to = !t.active
    if (!confirm(to ? `¿Reactivar «${t.name}»?` : `¿Desactivar «${t.name}»? Sus usuarios no podrán operar y se detienen sus procesos automáticos. No se borra ningún dato.`)) return
    await run(() => api.updateTenant(id, { active: to }), to ? 'Tenant reactivado' : 'Tenant desactivado')
  }

  const saveJson = async () => {
    let parsed: any
    try { parsed = JSON.parse(json) } catch (e: any) { toast(`JSON no válido: ${e.message}`, 'err'); return }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { toast('Debe ser un objeto { "clave": valor }', 'err'); return }
    if (Object.keys(parsed).some(k => k.startsWith('secrets.'))) { toast('Las credenciales se editan en la pestaña Integraciones', 'err'); return }
    const current = Object.keys(t.settings).filter(k => !k.startsWith('secrets.'))
    const body: Record<string, unknown> = { ...parsed }
    for (const k of current) if (!(k in parsed)) body[k] = null    // clave eliminada del JSON → se borra
    await run(() => api.setTenantSettings(id, body), 'Ajustes guardados')
  }

  const testModule = async (module: string) => {
    try {
      const r = await api.testTenantSecrets(id, module)
      if (r.data.ok) toast(`${meta.modules[module]!.label}: credenciales presentes`)
      else toast(`${meta.modules[module]!.label}: faltan ${r.data.missing.join(', ')}`, 'warn')
    } catch (e: any) { toast(e.message, 'err') }
  }

  const activeMods = useMemo(() => meta.features.filter(k => t?.features?.[k] && meta.modules[k]!.secrets.length), [t, meta])

  if (!t) return <Modal title="Cargando…" onClose={onClose}><div className="loading">Cargando…</div></Modal>

  return (
    <Modal title={`${t.name} (${t.slug})${t.active ? '' : ' — inactivo'}`} onClose={onClose} wide footer={
      <>
        <button className="btn btn-ghost" onClick={impersonate} disabled={!t.active}>🛟 Entrar como</button>
        <button className="btn btn-ghost" onClick={() => run(() => api.seedTenant(id), 'Datos base comprobados')} disabled={busy} title="Crea lo que falte (cuentas, canales, facturación…)">Re-sembrar datos base</button>
        <button className="btn btn-ghost" style={{ color: t.active ? 'var(--red)' : 'var(--green)' }} onClick={toggleActive} disabled={busy}>{t.active ? 'Desactivar' : 'Reactivar'}</button>
        <button className="btn btn-primary" onClick={onClose}>Cerrar</button>
      </>
    }>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
        {TABS.map(x => (
          <button key={x} onClick={() => setTab(x)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 13,
            color: tab === x ? 'var(--accent)' : 'var(--text2)', fontWeight: tab === x ? 700 : 400,
            borderBottom: tab === x ? '2px solid var(--accent)' : '2px solid transparent',
          }}>{x}</button>
        ))}
      </div>

      {tab === 'Datos' && (
        <>
          <IdentityFields f={form} set={set} />
          <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>Contacto, web y marca</h4>
          <ContactFields f={form} set={set} platform />
          <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={busy} onClick={() => run(() => api.updateTenant(id, form), 'Datos guardados')}>Guardar datos</button>
        </>
      )}

      {tab === 'Módulos' && (
        <>
          <ModuleToggles meta={meta} value={features} onChange={(k, v) => setFeatures(f => ({ ...f, [k]: v }))} />
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.setTenantFeatures(id, features), 'Módulos guardados')}>Guardar módulos</button>
        </>
      )}

      {tab === 'Integraciones' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>Solo escritura: las credenciales guardadas no se muestran (solo los 4 últimos caracteres). Deja vacío lo que no quieras cambiar.</p>
          <SecretInputs meta={meta} enabled={t.features} values={secrets} status={t.settings} onChange={(n, v) => setSecrets(s => ({ ...s, [n]: v }))} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={busy || Object.values(secrets).every(v => !v.trim())}
              onClick={() => run(async () => { await api.setTenantSettings(id, secretsPayload(secrets)); setSecrets({}) }, 'Credenciales guardadas')}>Guardar credenciales</button>
            {activeMods.map(k => (
              <button key={k} className="btn btn-ghost btn-xs" onClick={() => testModule(k)}>Comprobar {meta.modules[k]!.label}</button>
            ))}
          </div>
        </>
      )}

      {tab === 'Ajustes avanzados' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
            Ajustes libres del tenant (p. ej. <code>pricing.rootRateId</code>, <code>bookingEngine.channelId</code>, <code>channels.exemptFromUnpaidAlert</code>). Las credenciales no aparecen aquí. Quitar una clave la borra.
          </p>
          <textarea value={json} onChange={e => setJson(e.target.value)} spellCheck={false}
            style={{ width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 12 }} />
          <JsonStatus text={json} />
          <button className="btn btn-primary" style={{ marginTop: 8 }} disabled={busy} onClick={saveJson}>Guardar ajustes</button>
        </>
      )}

      {tab === 'Usuarios' && (
        <table>
          <thead><tr><th>Nombre</th><th>Email</th><th>Estado</th><th>Último acceso</th></tr></thead>
          <tbody>
            {t.users.map((u: any) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td>{u.firstName} {u.lastName}{u.isPrimary && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>ADMIN</span>}</td>
                <td style={{ fontSize: 13 }}>{u.email}</td>
                <td style={{ fontSize: 12 }}>{u.active ? '● Activo' : '○ Inactivo'}</td>
                <td style={{ fontSize: 12, color: 'var(--text2)' }}>{fmtDate(u.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'Auditoría' && (
        !audit ? <div className="loading">Cargando…</div> :
        audit.length === 0 ? <p style={{ color: 'var(--text2)' }}>Sin registros.</p> :
        <table>
          <thead><tr><th>Fecha</th><th>Acción</th><th>Por</th><th>Detalle</th></tr></thead>
          <tbody>
            {audit.map(a => (
              <tr key={a.id}>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(a.createdAt)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.action}</td>
                <td style={{ fontSize: 12 }}>{a.by ?? '—'}</td>
                <td style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'monospace' }}>{JSON.stringify(a.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

function JsonStatus({ text }: { text: string }) {
  let err: string | null = null
  try { const v = JSON.parse(text); if (v === null || typeof v !== 'object' || Array.isArray(v)) err = 'Debe ser un objeto' } catch (e: any) { err = e.message }
  return <div style={{ fontSize: 12, marginTop: 4, color: err ? 'var(--red)' : 'var(--green)' }}>{err ? `✕ ${err}` : '✓ JSON válido'}</div>
}
