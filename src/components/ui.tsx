"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean; block?: boolean };
export function Button({ variant = "primary", busy, block, className, children, disabled, ...p }: BtnProps) {
  const styles = {
    primary: "bg-sage text-white hover:bg-sage-strong dark:text-[#10201A]",
    secondary: "bg-surface text-ink border border-line hover:bg-sunken",
    ghost: "text-sage hover:bg-sage-soft",
    danger: "bg-allergy text-white hover:opacity-90 dark:text-[#2A0F12]",
  }[variant];
  return (
    <button {...p} disabled={disabled || busy} aria-busy={busy || undefined}
      className={cx("inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-5 font-semibold transition disabled:opacity-50", styles, block && "w-full", className)}>
      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}
export function LinkButton({ href, variant = "primary", className, children, block }: { href: string; variant?: BtnProps["variant"]; className?: string; children: ReactNode; block?: boolean }) {
  const styles = { primary: "bg-sage text-white dark:text-[#10201A]", secondary: "bg-surface text-ink border border-line", ghost: "text-sage", danger: "bg-allergy text-white" }[variant];
  return <Link href={href} className={cx("inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-5 font-semibold", styles, block && "w-full", className)}>{children}</Link>;
}

export function Card({ children, className, as: As = "section", ...p }: { children: ReactNode; className?: string; as?: "section" | "div" | "article"; "aria-label"?: string }) {
  return <As className={cx("card p-4", className)} {...p}>{children}</As>;
}

export function Field({ label, hint, error, children, required }: { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => ReactNode; required?: boolean }) {
  const id = useId();
  const d = [hint && `${id}-h`, error && `${id}-e`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">{label}{required && <span className="text-ink-2"> (required)</span>}</label>
      {children(id, d)}
      {hint && <p id={`${id}-h`} className="text-sm text-ink-2">{hint}</p>}
      {error && <p id={`${id}-e`} role="alert" className="text-sm font-medium text-allergy">{error}</p>}
    </div>
  );
}
const fieldCls = "min-h-12 w-full rounded-[14px] border border-line bg-sunken px-4 text-base text-ink placeholder:text-ink-2 focus:border-sage";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(fieldCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(fieldCls, "pr-8", p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(fieldCls, "min-h-24 py-3", p.className)} />;

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx("flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border px-2 text-sm font-semibold transition",
            value === o.value ? "border-sage bg-sage-soft text-ink" : "border-line bg-surface text-ink-2")}>
          {o.icon}<span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div><label htmlFor={id} className="font-semibold">{label}</label>{description && <p className="text-sm text-ink-2">{description}</p>}</div>
      <button id={id} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cx("relative h-8 w-14 shrink-0 rounded-full transition", checked ? "bg-sage" : "bg-line")}>
        <span className={cx("absolute top-1 h-6 w-6 rounded-full bg-white shadow transition", checked ? "left-7" : "left-1")} />
      </button>
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "info" | "caution" | "allergy" | "success"; children: ReactNode }) {
  const t = { neutral: "bg-sunken text-ink-2", info: "bg-info-bg text-info", caution: "bg-caution-bg text-caution", allergy: "bg-allergy-bg text-allergy", success: "bg-sage-soft text-sage-strong" }[tone];
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold", t)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-2xl bg-sunken", className)} />;
}
export function Loading({ label = "Loading" }: { label?: string }) {
  return <div role="status" aria-label={label} className="flex flex-col gap-3"><Skeleton className="h-24" /><Skeleton className="h-40" /><Skeleton className="h-24" /><span className="sr-only">{label}…</span></div>;
}
export function EmptyState({ title, body, action, icon = "🌙" }: { title: string; body?: string; action?: ReactNode; icon?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[20px] border border-dashed border-line px-6 py-10 text-center">
      <span aria-hidden className="text-4xl">{icon}</span>
      <h3 className="text-lg font-bold">{title}</h3>
      {body && <p className="max-w-sm text-ink-2">{body}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-[20px] bg-allergy-bg p-4 text-allergy">
      <p className="font-semibold">{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
export function Notice({ tone = "info", title, children }: { tone?: "info" | "caution" | "allergy"; title?: string; children: ReactNode }) {
  const t = { info: "bg-info-bg text-info", caution: "bg-caution-bg text-caution", allergy: "bg-allergy-bg text-allergy" }[tone];
  return <div className={cx("rounded-2xl p-3 text-sm", t)} role={tone === "allergy" ? "alert" : "note"}>{title && <p className="font-bold">{title}</p>}<div>{children}</div></div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl bg-sunken p-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">{label}</span>
      <span className="num font-display text-2xl font-extrabold">{value}</span>
      {sub && <span className="text-xs text-ink-2">{sub}</span>}
    </div>
  );
}

// ---------- Sheet (modal dialog) ----------
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title}
      className="m-0 mt-auto w-full max-w-none rounded-t-[28px] bg-surface p-0 text-ink backdrop:bg-black/40 sm:m-auto sm:max-w-lg sm:rounded-[28px]">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-lg font-bold">{title}</h2>
        <button onClick={onClose} className="min-h-12 min-w-12 rounded-full text-2xl" aria-label="Close">×</button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-5 safe-bottom">{children}</div>
    </dialog>
  );
}

// ---------- Toast with undo ----------
type ToastT = { id: number; text: string; action?: { label: string; run: () => void }; tone?: "success" | "error" | "info" };
const ToastCtx = createContext<(t: Omit<ToastT, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((t: Omit<ToastT, "id">) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { ...t, id }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), t.action ? 10_000 : 4_000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div key={t.id} className={cx("pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-2xl px-4 py-3 shadow-lg",
            t.tone === "error" ? "bg-allergy text-white" : "bg-ink text-canvas")}>
            <span className="text-sm font-medium">{t.text}</span>
            {t.action && <button className="min-h-10 rounded-full px-3 font-bold underline" onClick={() => { t.action!.run(); setItems((x) => x.filter((i) => i.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function PageHeader({ title, back, action, subtitle }: { title: string; back?: string; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="mb-4 flex items-center gap-2">
      {back && <Link href={back} aria-label="Back" className="-ml-2 flex min-h-12 min-w-12 items-center justify-center rounded-full text-2xl hover:bg-sunken">‹</Link>}
      <div className="flex-1">
        <h1 className="text-2xl font-extrabold leading-tight">{title}</h1>
        {subtitle && <div className="text-sm text-ink-2">{subtitle}</div>}
      </div>
      {action}
    </header>
  );
}

export function ListRow({ href, title, sub, right, onClick }: { href?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void }) {
  const inner = (<><div className="min-w-0 flex-1"><div className="truncate font-semibold">{title}</div>{sub && <div className="text-sm text-ink-2">{sub}</div>}</div>{right}</>);
  const cls = "flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-sunken";
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  if (onClick) return <button onClick={onClick} className={cls}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}
