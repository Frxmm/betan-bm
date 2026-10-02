import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email,   setEmail]   = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setSending(true)
    try {
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al enviar el correo')
      setMessage(d.message)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  if (message) {
    return (
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>{message}</p>
        <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={onBack}>
          ← Volver a entrar
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ fontSize: 13, color: 'var(--text2)', margin: 0 }}>
        Escribe tu correo y te enviaremos un enlace para elegir una contraseña nueva.
      </p>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>Correo electrónico</label>
        <input
          type="email" autoComplete="email" autoFocus
          value={email} onChange={e => setEmail(e.target.value)}
          placeholder="usuario@hotel.es"
          required
        />
      </div>
      {error && <p style={{ color: 'var(--red)', fontSize: 13, margin: 0, textAlign: 'center' }}>{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={sending} style={{ padding: '10px 0', fontSize: 15 }}>
        {sending ? 'Enviando…' : 'Enviar enlace'}
      </button>
      <button type="button" className="btn btn-ghost" onClick={onBack} style={{ fontSize: 13 }}>
        ← Volver a entrar
      </button>
    </form>
  )
}

export default function LoginView() {
  const { login } = useAuth()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [forgot,   setForgot]   = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setLoading(true)
    try {
      await login(email, password)
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
          <p style={{ color: 'var(--text2)', fontSize: 13, marginTop: 4 }}>
            {forgot ? 'Recupera tu contraseña' : 'Inicia sesión para continuar'}
          </p>
        </div>

        {forgot ? (
          <ForgotPasswordForm onBack={() => setForgot(false)} />
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Correo electrónico</label>
              <input
                type="email" autoComplete="email" autoFocus
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="usuario@hotel.es"
                required
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Contraseña</label>
              <input
                type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)}
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
              {loading ? 'Entrando…' : 'Entrar'}
            </button>
            <button
              type="button" className="btn btn-ghost"
              onClick={() => setForgot(true)}
              style={{ fontSize: 13 }}
            >
              ¿Olvidaste tu contraseña?
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
