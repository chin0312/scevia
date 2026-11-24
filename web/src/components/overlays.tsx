/* Popovers, menus, modal, drawer, toast and the ⓘ InfoTip. Keyboard: Esc closes, focus returns. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

/* close on outside click + Escape */
export function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close, ref])
}

/* Dropdown menu anchored to a trigger */
export function Menu({ trigger, children, align = 'right', width = 260 }: { trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, ref)
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className="menu" role="menu" style={{ [align]: 0, width }}>{children(close)}</div>}
    </div>
  )
}

/* ⓘ "How calculated" popover — hover or focus */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="itip-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="itip" aria-label="How this is calculated" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>i</button>
      {open && <span className="itip-pop" role="tooltip"><b>How calculated</b>{text}</span>}
    </span>
  )
}

/* Modal + Drawer share a portal + scrim */
function Layer({ onClose, children, kind }: { onClose: () => void; children: ReactNode; kind: 'modal' | 'drawer' | 'palette' }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])
  return createPortal(
    <div className={`layer layer-${kind}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>{children}</div>,
    document.body,
  )
}

export function Modal({ title, sub, onClose, children, footer, width = 520 }: { title: string; sub?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <Layer onClose={onClose} kind="modal">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="modal-h"><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </Layer>
  )
}

export function Drawer({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  return (
    <Layer onClose={onClose} kind="drawer">
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h"><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button></div>
        <div className="drawer-b">{children}</div>
      </aside>
    </Layer>
  )
}
export { Layer }

/* Toasts */
interface Toast { id: number; text: string; tone: 'ok' | 'info' }
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'info') => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: 'ok' | 'info' = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((t) => [...t, { id, text, tone }])
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" aria-live="polite">
          {items.map((t) => <div key={t.id} className="toast"><Icon name={t.tone === 'ok' ? 'check' : 'info'} size={15} />{t.text}</div>)}
        </div>, document.body)}
    </ToastCtx.Provider>
  )
}
