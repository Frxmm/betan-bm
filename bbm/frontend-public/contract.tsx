import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { pfetch, branding, boot } from './branding'

// ─── Página pública de firma del contrato de huésped (/sign?t=<token>) ────────

function useToken(): string {
  return new URLSearchParams(window.location.search).get('t') ?? ''
}

function SignaturePad({ onChange }: { onChange: (hasInk: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing   = useRef(false)
  const hasInk    = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width  = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#1a1a6e'

    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const down = (e: PointerEvent) => {
      e.preventDefault()
      drawing.current = true
      canvas.setPointerCapture(e.pointerId)
      const p = pos(e)
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
    }
    const move = (e: PointerEvent) => {
      if (!drawing.current) return
      e.preventDefault()
      const p = pos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      if (!hasInk.current) { hasInk.current = true; onChange(true) }
    }
    const up = () => { drawing.current = false }

    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [])

  const clear = () => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    hasInk.current = false
    onChange(false)
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: 180, touchAction: 'none', display: 'block',
          border: '2px dashed #94a3b8', borderRadius: 10, background: '#fff',
        }}
      />
      <button type="button" onClick={clear} style={btnGhost}>Borrar firma</button>
    </div>
  )
}

// getSignature: exportado por ref simple — el padre lee el canvas directamente
function App() {
  const token = useToken()
  const [state, setState]     = useState<'loading' | 'pending' | 'signed' | 'sending' | 'done' | 'error'>('loading')
  const [error, setError]     = useState('')
  const [html, setHtml]       = useState('')
  const [canSign, setCanSign] = useState(false)

  useEffect(() => {
    if (!token) { setError('Enlace inválido'); setState('error'); return }
    pfetch(`/api/public/contract/${token}`)
      .then(async r => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error ?? 'Error')
        if (d.data.status === 'signed') { setState('signed'); return }
        setHtml(d.data.html)
        setState('pending')
      })
      .catch(e => { setError(e.message); setState('error') })
  }, [])

  const submit = async () => {
    const canvas = document.querySelector('canvas')
    if (!canvas) return
    setState('sending')
    try {
      const r = await pfetch(`/api/public/contract/${token}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature: canvas.toDataURL('image/png') }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Error al enviar la firma')
      setState('done')
    } catch (e: any) { setError(e.message); setState('error') }
  }

  if (state === 'loading') return <Center>Cargando contrato…</Center>
  if (state === 'error')   return <Center>⚠️ {error}</Center>
  if (state === 'signed')  return <Center>✅ Este contrato ya fue firmado. ¡Gracias!</Center>
  if (state === 'done')    return <Center>✅ Contrato firmado correctamente.<br/>Ya puede cerrar esta página. ¡Bienvenido a {branding.name}!</Center>

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '12px 12px 40px', fontFamily: 'Arial, sans-serif' }}>
      <iframe
        srcDoc={html}
        title="Contrato"
        style={{ width: '100%', height: '55vh', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 16, background: '#fff' }}
      />
      <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Firme aquí con el dedo:</h3>
      <SignaturePad onChange={setCanSign} />
      <button
        type="button"
        disabled={!canSign || state === 'sending'}
        onClick={submit}
        style={{ ...btnPrimary, opacity: !canSign || state === 'sending' ? 0.5 : 1 }}
      >
        {state === 'sending' ? 'Enviando…' : 'Firmar y enviar'}
      </button>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', fontFamily: 'Arial, sans-serif', fontSize: 18, padding: 20, lineHeight: 1.6,
    }}>{children}</div>
  )
}

const btnPrimary: React.CSSProperties = {
  display: 'block', width: '100%', marginTop: 14, padding: '14px 0', fontSize: 17, fontWeight: 700,
  color: '#fff', background: '#1d4ed8', border: 'none', borderRadius: 10, cursor: 'pointer',
}
const btnGhost: React.CSSProperties = {
  marginTop: 8, padding: '8px 14px', fontSize: 14, background: 'none',
  border: '1px solid #cbd5e1', borderRadius: 8, cursor: 'pointer', color: '#475569',
}

boot(() => createRoot(document.getElementById('root')!).render(
  <App />
))
