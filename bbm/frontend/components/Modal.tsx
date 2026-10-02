import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  title: string
  onClose: () => void
  footer?: React.ReactNode
  wide?: boolean
  width?: number
  // blocking: sin aspa, sin cerrar con Escape ni clic en el fondo — para
  // avisos que el usuario debe confirmar explícitamente (ver
  // ImportantStaffMessagePopup.tsx). onClose sigue siendo necesario (footer
  // normalmente lo llama desde su propio botón), solo se desactivan las
  // otras tres vías de cierre.
  blocking?: boolean
  children: React.ReactNode
}

export function Modal({ title, onClose, footer, wide, width, blocking, children }: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (blocking) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, blocking])

  return createPortal(
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onClick={e => { if (!blocking && e.target === backdropRef.current) onClose() }}
    >
      <div className={`modal${wide ? ' modal-wide' : ''}`} style={width ? { maxWidth: width } : undefined}>
        <div className="modal-header">
          <h2>{title}</h2>
          {!blocking && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
