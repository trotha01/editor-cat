/** Small shared UI primitives, so the feature components stay readable. */
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 disabled:hover:brightness-100',
  secondary: 'bg-surface-2 text-ink hover:bg-line disabled:hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-dim hover:text-ink hover:bg-surface-2',
  danger: 'bg-red-500/15 text-red-300 hover:bg-red-500/25',
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-xs font-semibold tracking-wide text-ink-dim uppercase"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs leading-relaxed text-ink-dim">{hint}</p> : null}
    </div>
  )
}

const CONTROL =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-dim/60 focus:border-accent focus:outline-none disabled:opacity-50'

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${className}`} />
}

export function TextArea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL} resize-y leading-relaxed ${className}`} />
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${className}`} />
}

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success'
  title?: string
  children: ReactNode
}) {
  const tones = {
    info: 'border-accent/30 bg-accent/10 text-ink',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-100',
    error: 'border-red-500/35 bg-red-500/10 text-red-100',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100',
  }
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm leading-relaxed ${tones[tone]}`}>
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      <div className="[overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Working"
      className={`inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className={`m-auto w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/60 ${
        wide ? 'max-w-3xl' : 'max-w-lg'
      }`}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="text-base font-semibold">{title}</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  )
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <span aria-hidden className="text-3xl">
        {icon}
      </span>
      <p className="font-medium">{title}</p>
      {children ? (
        <p className="max-w-sm text-sm leading-relaxed text-ink-dim">{children}</p>
      ) : null}
    </div>
  )
}
