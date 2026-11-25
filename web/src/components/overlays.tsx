/* Popovers, menus, modal, drawer, toast and the ⓘ InfoTip.
   Keyboard: Esc closes, Tab is trapped inside modal layers, focus returns to the trigger on close. */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)

/** Trap Tab inside `ref`, focus the first field (or [data-autofocus]) on open, restore focus on close. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root
    first.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const els = focusables(root)
      if (!els.length) { e.preventDefault(); return }
      const i = els.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); els[els.length - 1].focus() }
      else if (!e.shiftKey && i === els.length - 1) { e.preventDefault(); els[0].focus() }
    }
    root.addEventListener('keydown', onKey)
    // Return focus to where the user was, if that element still exists (it may have been re-rendered away).
    return () => { root.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [ref])
}

/* ── Layer stack ──────────────────────────────────────────────
   Every modal layer (modal, drawer, palette) registers here, in opening order. One listener sends Esc to the
   topmost layer only; layers underneath are made inert so focus and clicks can't reach them; the page's scroll
   is locked once while any layer is open and restored when the last one closes. */
interface LayerEntry { id: number; el: HTMLElement; close: () => void }
const layers: LayerEntry[] = []
let savedOverflow: string | null = null
let nextLayerId = 1
function syncLayers() {
  layers.forEach((l, i) => { if (i === layers.length - 1) l.el.removeAttribute('inert'); else l.el.setAttribute('inert', '') })
}
function onLayerKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !layers.length) return
  e.preventDefault(); e.stopPropagation()
  layers[layers.length - 1].close()
}
function pushLayer(entry: LayerEntry) {
  if (!layers.length) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onLayerKey, true)
  }
  layers.push(entry); syncLayers()
}
function removeLayer(id: number) {
  const i = layers.findIndex((l) => l.id === id)
  if (i >= 0) layers.splice(i, 1)
  syncLayers()
  if (!layers.length) {
    document.body.style.overflow = savedOverflow ?? ''
    savedOverflow = null
    document.removeEventListener('keydown', onLayerKey, true)
  }
}
/** Number of open modal layers (for tests and diagnostics). */
export const openLayerCount = () => layers.length
/** Move focus to the topmost layer (e.g. after its content was replaced). */
export function focusTopLayer() {
  const top = layers[layers.length - 1]?.el.querySelector<HTMLElement>('.layer-inner')
  top?.focus({ preventScroll: true })
}

/* Dropdown menu anchored to a trigger. Arrow keys move between items; Esc closes and refocuses the trigger. */
export interface TriggerProps { 'aria-expanded': boolean; 'aria-haspopup': 'menu'; 'aria-controls': string; onClick: () => void; ref: React.RefObject<HTMLButtonElement | null> }
export function Menu({ trigger, children, align = 'right', width = 260, label }: { trigger: (p: TriggerProps) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: number; label: string }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null)
  const id = useId()
  const close = useCallback((refocus = true) => { setOpen(false); if (refocus) btn.current?.focus() }, [])
  useEffect(() => {
    if (!open) return
    const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
    items()[0]?.focus()
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) close(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      if (e.key === 'Tab') close(false)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const els = items(), i = els.indexOf(document.activeElement as HTMLElement)
        els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close])
  return (
    <div className="menu-wrap" ref={wrap}>
      {trigger({ 'aria-expanded': open, 'aria-haspopup': 'menu', 'aria-controls': id, onClick: () => setOpen((o) => !o), ref: btn })}
      {open && <div className="menu" id={id} role="menu" aria-label={label} ref={menu} style={{ [align]: 0, width }}>{children(() => close())}</div>}
    </div>
  )
}

/* ⓘ "How calculated" popover — hover or focus; Esc dismisses. */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="itip-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="itip" aria-label="How this is calculated" aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>i</button>
      {open && <span className="itip-pop" role="tooltip" id={id}><b>How calculated</b>{text}</span>}
    </span>
  )
}

/* Modal + Drawer + palette share a portal, scrim, Esc handling and focus trap. */
export function Layer({ onClose, children, kind, label }: { onClose: () => void; children: ReactNode; kind: 'modal' | 'drawer' | 'palette'; label: string }) {
  const ref = useRef<HTMLDivElement>(null), outer = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    const id = nextLayerId++
    pushLayer({ id, el: outer.current!, close: () => closeRef.current() })
    return () => removeLayer(id)
  }, [])
  useFocusTrap(ref)
  return createPortal(
    <div ref={outer} className={`layer layer-${kind}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="layer-inner">{children}</div>
    </div>,
    document.body,
  )
}

export function Modal({ title, sub, onClose, children, footer, width = 520 }: { title: string; sub?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <Layer onClose={onClose} kind="modal" label={title}>
      <div className="modal" style={{ width }}>
        <div className="modal-h"><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </Layer>
  )
}

export function Drawer({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  return (
    <Layer onClose={onClose} kind="drawer" label={title}>
      <aside className="drawer">
        <div className="modal-h"><div><h3>{title}</h3>{sub && <p>{sub}</p>}</div><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button></div>
        <div className="drawer-b">{children}</div>
      </aside>
    </Layer>
  )
}

/* Toasts (announced politely to screen readers) */
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
        <div className="toasts" role="status" aria-live="polite">
          {items.map((t) => <div key={t.id} className="toast"><Icon name={t.tone === 'ok' ? 'check' : 'info'} size={15} />{t.text}</div>)}
        </div>, document.body)}
    </ToastCtx.Provider>
  )
}
