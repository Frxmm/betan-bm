import React, { useState, useRef, useEffect } from 'react'
import { SUPPORTED_LANGS, LANG_LABELS, type Lang } from './i18n'

const FLAG: Record<Lang, string> = {
  es: '🇪🇸', en: '🇬🇧', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', uk: '🇺🇦', zh: '🇨🇳',
}

// Selector de idioma visible para páginas standalone (booking.tsx, portal.tsx),
// a las que se puede llegar directamente por URL (ej. desde el email) sin pasar
// por el sitio principal, que es quien decide el idioma en los widgets embebidos.
export function LangSwitcher({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none',
          border: '1px solid var(--border)', borderRadius: 8, padding: '5px 10px',
          fontSize: 13, cursor: 'pointer', color: 'var(--text)',
        }}
      >
        <span>{FLAG[lang]}</span><span>{LANG_LABELS[lang]}</span><span style={{ fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 50,
          background: 'var(--surface, #fff)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,.15)', minWidth: 150, overflow: 'hidden',
        }}>
          {SUPPORTED_LANGS.map(l => (
            <div key={l}
              onClick={() => { onChange(l); setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                cursor: 'pointer', fontSize: 13, fontWeight: l === lang ? 700 : 400,
                background: l === lang ? 'var(--bg2, #f4f6f8)' : 'transparent',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2, #f4f6f8)')}
              onMouseLeave={e => (e.currentTarget.style.background = l === lang ? 'var(--bg2, #f4f6f8)' : 'transparent')}
            >
              <span>{FLAG[l]}</span><span>{LANG_LABELS[l]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
