import { useState, useEffect, useRef } from 'react'
import { toast } from '../lib/utils'
import { useAuth, canManage } from '../contexts/AuthContext'
import { useProperty } from '../contexts/PropertyContext'
import { api } from '../lib/api'

type Theme  = 'dark' | 'light' | 'special' | 'retro' | 'forest' | 'hotdog'
type Font   = 'system' | 'inter' | 'georgia' | 'mono'

const THEMES: { id: Theme; label: string; bg: string; bg2: string; accent: string; emoji?: string }[] = [
  { id: 'dark',    label: 'Oscuro',        bg: '#0f1117', bg2: '#1a1d27', accent: '#4f7cff' },
  { id: 'light',   label: 'Claro',         bg: '#f0f2f8', bg2: '#ffffff', accent: '#3b6ef0' },
  { id: 'special', label: 'Especial',      bg: '#070d1a', bg2: '#0d1628', accent: '#38bdf8' },
  { id: 'retro',   label: 'Retro',         bg: '#0c0900', bg2: '#160e00', accent: '#ffb800' },
  { id: 'forest',  label: 'Bosque',        bg: '#111a12', bg2: '#192b1b', accent: '#5aaa3e' },
  { id: 'hotdog',  label: '🌭 Hotdog',     bg: '#8b1a00', bg2: '#c49000', accent: '#fff8e0', emoji: '🌭' },
]

const FONTS: { id: Font; label: string; sample: string; style: string }[] = [
  { id: 'system',  label: 'Sistema',  sample: 'Aa',     style: "-apple-system, sans-serif" },
  { id: 'inter',   label: 'Inter',    sample: 'Aa',     style: "'Inter', sans-serif" },
  { id: 'georgia', label: 'Georgia',  sample: 'Aa',     style: "Georgia, serif" },
  { id: 'mono',    label: 'Mono',     sample: 'Aa',     style: "'Courier New', monospace" },
]

const SIZES: { value: number; label: string }[] = [
  { value: 12, label: 'XS' },
  { value: 13, label: 'S' },
  { value: 14, label: 'M' },
  { value: 15, label: 'L' },
  { value: 16, label: 'XL' },
]

export function applyPrefs(prefs: { theme: Theme; fontFamily: Font; fontSize: number }) {
  document.documentElement.setAttribute('data-theme',  prefs.theme)
  document.documentElement.setAttribute('data-font',   prefs.fontFamily)
  document.documentElement.style.fontSize = prefs.fontSize + 'px'
  try { localStorage.setItem('bm-prefs', JSON.stringify(prefs)) } catch {}
}


export default function SettingsView() {
  const { user, refreshUser } = useAuth()
  const [theme,  setTheme]  = useState<Theme>('dark')
  const [font,   setFont]   = useState<Font>('system')
  const [size,   setSize]   = useState(14)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/settings/me')
      .then(r => r.json())
      .then((r: any) => {
        const p = r.data
        setTheme(p.theme); setFont(p.fontFamily); setSize(p.fontSize)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  // Preview en tiempo real
  useEffect(() => {
    if (!loaded) return
    applyPrefs({ theme, fontFamily: font, fontSize: size })
  }, [theme, font, size, loaded])

  const save = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, fontFamily: font, fontSize: size }),
      })
      toast('Configuración guardada')
    } catch { toast('Error al guardar', 'err') }
    finally { setSaving(false) }
  }

  if (!loaded) return <div className="loading">Cargando…</div>

  return (
    <div style={{ maxWidth: 640 }}>
      <ProfileSection user={user} onSaved={refreshUser} />
      {canManage(user) && <PropertySection />}
      {canManage(user) && <FeaturesSection />}
      <h2 style={{ marginBottom: 28, fontSize: 18, fontWeight: 700 }}>Apariencia</h2>

      {/* Tema */}
      <div className="settings-section">
        <h3>Tema</h3>
        <div className="theme-grid">
          {THEMES.map(t => (
            <div key={t.id} className={`theme-card${theme === t.id ? ' active' : ''}`}
              onClick={() => setTheme(t.id)}>
              <div className="theme-preview" style={{ background: t.bg }}>
                <div className="theme-preview-bar" style={{ background: t.bg2, width: '100%' }} />
                <div className="theme-preview-bar" style={{ background: t.accent, width: '60%' }} />
                <div className="theme-preview-bar" style={{ background: t.bg2, width: '80%' }} />
              </div>
              <div className="theme-label">{t.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Fuente */}
      <div className="settings-section">
        <h3>Fuente</h3>
        <div className="font-grid">
          {FONTS.map(f => (
            <div key={f.id} className={`font-card${font === f.id ? ' active' : ''}`}
              style={{ fontFamily: f.style }}
              onClick={() => setFont(f.id)}>
              <span>{f.sample}</span>
              <small>{f.label}</small>
            </div>
          ))}
        </div>
      </div>

      {/* Tamaño */}
      <div className="settings-section">
        <h3>Tamaño de texto</h3>
        <div className="size-grid">
          {SIZES.map(s => (
            <div key={s.value} className={`size-card${size === s.value ? ' active' : ''}`}
              style={{ fontSize: s.value }}
              onClick={() => setSize(s.value)}>
              {s.label} — {s.value}px
            </div>
          ))}
        </div>
      </div>

      <button className="btn btn-primary" onClick={save} disabled={saving} style={{ marginTop: 8 }}>
        {saving ? 'Guardando…' : 'Guardar configuración'}
      </button>
    </div>
  )
}

// ─── Sección de perfil ───────────────────────────────────────────────────────

function ProfileSection({ user, onSaved }: { user: any; onSaved: () => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarFile,    setAvatarFile]    = useState<File | null>(null)

  const [firstName, setFirstName] = useState(user?.firstName ?? '')
  const [lastName,  setLastName]  = useState(user?.lastName  ?? '')
  const [email,     setEmail]     = useState(user?.email     ?? '')

  const [currentPwd, setCurrentPwd] = useState('')
  const [newPwd,     setNewPwd]     = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')

  const [saving, setSaving] = useState(false)

  const avatarSrc = avatarPreview ?? (user?.avatarUrl ? user.avatarUrl + '?t=' + Date.now() : null)
  const initials  = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase()

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setAvatarFile(f)
    setAvatarPreview(URL.createObjectURL(f))
  }

  const saveProfile = async () => {
    if (newPwd && newPwd !== confirmPwd) { toast('Las contraseñas no coinciden', 'err'); return }
    setSaving(true)
    try {
      // 1. Avatar
      if (avatarFile) {
        const fd = new FormData()
        fd.append('avatar', avatarFile)
        const r = await fetch('/api/settings/me/avatar', { method: 'POST', credentials: 'include', body: fd })
        const j = await r.json()
        if (!r.ok) { toast(j.error ?? 'Error subiendo foto', 'err'); setSaving(false); return }
      }

      // 2. Datos de perfil
      const body: Record<string, string> = {}
      if (firstName !== user?.firstName) body.firstName = firstName
      if (lastName  !== user?.lastName)  body.lastName  = lastName
      if (email     !== user?.email)     body.email     = email
      if (newPwd) { body.currentPassword = currentPwd; body.newPassword = newPwd }

      if (Object.keys(body).length > 0) {
        const r = await fetch('/api/settings/me/profile', {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json()
        if (!r.ok) { toast(j.error ?? 'Error al guardar', 'err'); setSaving(false); return }
      }

      await onSaved()
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('')
      setAvatarFile(null)
      toast('Perfil actualizado')
    } catch { toast('Error al guardar perfil', 'err') }
    finally { setSaving(false) }
  }

  return (
    <div className="settings-section" style={{ marginBottom: 32 }}>
      <h2 style={{ marginBottom: 20, fontSize: 18, fontWeight: 700 }}>Perfil</h2>

      {/* Avatar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div
          className="profile-avatar"
          onClick={() => fileRef.current?.click()}
          title="Cambiar foto"
        >
          {avatarSrc
            ? <img src={avatarSrc} alt="avatar" />
            : <span>{initials}</span>
          }
          <div className="profile-avatar-overlay">📷</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{user?.firstName} {user?.lastName}</div>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{user?.roles?.join(', ')}</div>
          <button className="btn btn-ghost btn-xs" style={{ marginTop: 6 }} onClick={() => fileRef.current?.click()}>
            Cambiar foto
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pickFile} />
      </div>

      {/* Nombre */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <label className="profile-field">
          <span>Nombre</span>
          <input className="form-input" value={firstName} onChange={e => setFirstName(e.target.value)} />
        </label>
        <label className="profile-field">
          <span>Apellidos</span>
          <input className="form-input" value={lastName} onChange={e => setLastName(e.target.value)} />
        </label>
      </div>

      {/* Email */}
      <label className="profile-field" style={{ display: 'block', marginBottom: 20 }}>
        <span>Correo electrónico</span>
        <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} style={{ width: '100%' }} />
      </label>

      {/* Contraseña */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>
          Cambiar contraseña
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label className="profile-field">
            <span>Contraseña actual</span>
            <input className="form-input" type="password" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} placeholder="Requerida para cambiar contraseña o email" style={{ width: '100%' }} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label className="profile-field">
              <span>Nueva contraseña</span>
              <input className="form-input" type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="Mín. 6 caracteres" />
            </label>
            <label className="profile-field">
              <span>Confirmar contraseña</span>
              <input className="form-input" type="password" value={confirmPwd} onChange={e => setConfirmPwd(e.target.value)} placeholder="Repite la nueva contraseña" />
            </label>
          </div>
        </div>
      </div>

      <button className="btn btn-primary" onClick={saveProfile} disabled={saving}>
        {saving ? 'Guardando…' : 'Guardar perfil'}
      </button>
    </div>
  )
}

// ─── Datos del establecimiento (branding / fiscal / contacto del tenant) ─────

const PROPERTY_FIELDS: { key: string; label: string; type?: string; placeholder?: string; full?: boolean }[] = [
  { key: 'name', label: 'Nombre comercial *' },
  { key: 'legalName', label: 'Razón social' },
  { key: 'vatNumber', label: 'CIF / NIF' },
  { key: 'touristRegistryNumber', label: 'Nº registro de turismo' },
  { key: 'starLabel', label: 'Categoría (estrellas)', placeholder: '★★★' },
  { key: 'address', label: 'Dirección' },
  { key: 'postalCode', label: 'Código postal' },
  { key: 'city', label: 'Ciudad' },
  { key: 'region', label: 'Provincia / región' },
  { key: 'countryCode', label: 'País (ISO 2)', placeholder: 'ES' },
  { key: 'phone', label: 'Teléfono', type: 'tel' },
  { key: 'email', label: 'Email general', type: 'email' },
  { key: 'receptionEmail', label: 'Email de recepción', type: 'email' },
  { key: 'fromEmail', label: 'Remitente de correos', placeholder: 'Hotel <reservas@dominio.com>' },
  { key: 'websiteUrl', label: 'Web', placeholder: 'https://' },
  { key: 'mapsUrl', label: 'Enlace de Google Maps' },
  { key: 'logoUrl', label: 'URL del logo' },
  { key: 'currencyCode', label: 'Moneda (ISO 3)', placeholder: 'EUR' },
  { key: 'timezone', label: 'Zona horaria', placeholder: 'Europe/Madrid' },
  { key: 'localeDefault', label: 'Idioma por defecto', placeholder: 'es' },
]

function PropertySection() {
  const { property, reload } = useProperty()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm(Object.fromEntries(PROPERTY_FIELDS.map(f => [f.key, String((property as any)[f.key] ?? '')])))
  }, [property])

  const save = async () => {
    if (!form.name?.trim()) { toast('El nombre es obligatorio', 'err'); return }
    setSaving(true)
    try {
      await api.updatePropertySettings(form)
      await reload()
      toast('Datos del establecimiento guardados')
    } catch (e: any) { toast(e.message ?? 'Error al guardar', 'err') }
    finally { setSaving(false) }
  }

  return (
    <div className="settings-section" style={{ marginBottom: 32 }}>
      <h2 style={{ marginBottom: 6, fontSize: 18, fontWeight: 700 }}>Datos del establecimiento</h2>
      <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 16 }}>
        Aparecen en facturas, contratos, correos y en la web de reservas.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        {PROPERTY_FIELDS.map(f => (
          <label key={f.key} className="profile-field">
            <span>{f.label}</span>
            <input className="form-input" type={f.type ?? 'text'} placeholder={f.placeholder}
              value={form[f.key] ?? ''} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <button className="btn btn-primary" onClick={save} disabled={saving}>
        {saving ? 'Guardando…' : 'Guardar datos del establecimiento'}
      </button>
    </div>
  )
}

// ─── Módulos contratados (solo lectura) ──────────────────────────────────────

function FeaturesSection() {
  const [mods, setMods] = useState<{ key: string; enabled: boolean; label: string; group: string; description: string }[] | null>(null)
  useEffect(() => { api.propertyFeatures().then(r => setMods(r.data)).catch(() => setMods([])) }, [])
  if (!mods || mods.length === 0) return null
  return (
    <div className="settings-section" style={{ marginBottom: 32 }}>
      <h2 style={{ marginBottom: 6, fontSize: 18, fontWeight: 700 }}>Módulos contratados</h2>
      <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
        Solo lectura. Para activar o desactivar módulos, contacta con el administrador de la plataforma.
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        {mods.map(m => (
          <div key={m.key} style={{ display: 'flex', gap: 10, alignItems: 'baseline', opacity: m.enabled ? 1 : 0.5 }}>
            <span style={{ color: m.enabled ? 'var(--green)' : 'var(--text2)', width: 14 }}>{m.enabled ? '●' : '○'}</span>
            <span style={{ fontSize: 13 }}>
              <strong>{m.label}</strong>
              <span style={{ color: 'var(--text2)', fontSize: 12 }}> — {m.description}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
