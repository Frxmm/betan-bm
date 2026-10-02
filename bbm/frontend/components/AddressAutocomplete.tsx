import { useEffect, useRef, useState } from 'react'

// ─── Autocompletado de dirección con Google Places (vía proxy del backend) ────
// Compartido entre el admin y las páginas públicas (portal): estilos inline.

export interface ParsedAddress {
  address1:    string
  zipCode:     string
  city:        string
  countryCode: string   // ISO-2 mayúsculas
  formatted:   string
}

export function AddressAutocomplete({ onSelect, placeholder }: {
  onSelect: (a: ParsedAddress) => void
  placeholder?: string
}) {
  const [q,        setQ]        = useState('')
  const [items,    setItems]    = useState<{ placeId: string; text: string }[]>([])
  const [open,     setOpen]     = useState(false)
  const [loading,  setLoading]  = useState(false)
  const timer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const search = (text: string) => {
    setQ(text)
    if (timer.current) clearTimeout(timer.current)
    if (text.trim().length < 3) { setItems([]); setOpen(false); return }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/public/places/autocomplete?q=${encodeURIComponent(text.trim())}`)
        const d = await r.json()
        if (r.ok) { setItems(d.data ?? []); setOpen(true) }
      } catch {}
    }, 300)
  }

  const pick = async (placeId: string, text: string) => {
    setOpen(false)
    setQ(text)
    setLoading(true)
    try {
      const r = await fetch(`/api/public/places/details/${encodeURIComponent(placeId)}`)
      const d = await r.json()
      if (r.ok && d.data) { onSelect(d.data as ParsedAddress); setQ('') }
    } catch {}
    finally { setLoading(false) }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        value={q}
        onChange={e => search(e.target.value)}
        onFocus={() => items.length > 0 && setOpen(true)}
        placeholder={placeholder ?? '🔍 Buscar dirección (Google Maps)…'}
        disabled={loading}
        style={{ width: '100%' }}
        autoComplete="off"
      />
      {open && items.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--bg2, #fff)', border: '1px solid var(--border, #cbd5e1)',
          borderRadius: 8, marginTop: 2, overflow: 'hidden',
          boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
        }}>
          {items.map(it => (
            <div
              key={it.placeId}
              onClick={() => pick(it.placeId, it.text)}
              style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid var(--border, #e2e8f0)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(79,124,255,0.10)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              📍 {it.text}
            </div>
          ))}
          <div style={{ padding: '4px 12px', fontSize: 10, color: 'var(--text2, #94a3b8)', textAlign: 'right' }}>
            powered by Google
          </div>
        </div>
      )}
    </div>
  )
}
