import { useState } from 'react'

// Página pública (no requiere sesión) a la que llega el enlace del correo de
// recuperación — ver App.tsx (se renderiza fuera del <Routes> normal, igual
// que LoginView, cuando la URL es /reset-password) y POST
// /api/auth/reset-password.
export default function ResetPasswordView() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''

  const [password,  setPassword]  = useState('')
  const [password2,  setPassword2] = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [done,      setDone]      = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 6) { setError('La contraseña debe tener al menos 6 caracteres'); return }
    if (password !== password2) { setError('Las contraseñas no coinciden'); return }
    setLoading(true)
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al cambiar la contraseña')
      setDone(true)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: 360, background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '36px 32px', boxShadow: '0 8px 40px rgba(0,0,0,.4)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 28, marginBottom: 6 }}>🏨</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Booking Manager</h1>
          <p style={{ color: 'var(--text2)', fontSize: 13, marginTop: 4 }}>Elige una contraseña nueva</p>
        </div>

        {!token ? (
          <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center' }}>
            Enlace no válido — falta el código de recuperación. Pide uno nuevo desde la pantalla de inicio de sesión.
          </p>
        ) : done ? (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: 'var(--text2)' }}>Contraseña actualizada correctamente.</p>
            <a href="/" className="btn btn-primary" style={{ display: 'inline-block', marginTop: 12, padding: '10px 24px', fontSize: 15 }}>
              Ir a iniciar sesión
            </a>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Contraseña nueva</label>
              <input
                type="password" autoComplete="new-password" autoFocus
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Repite la contraseña</label>
              <input
                type="password" autoComplete="new-password"
                value={password2} onChange={e => setPassword2(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <p style={{ color: 'var(--red)', fontSize: 13, margin: 0, textAlign: 'center' }}>{error}</p>
            )}

            <button
              type="submit" className="btn btn-primary"
              disabled={loading}
              style={{ marginTop: 4, padding: '10px 0', fontSize: 15 }}
            >
              {loading ? 'Guardando…' : 'Guardar contraseña'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
