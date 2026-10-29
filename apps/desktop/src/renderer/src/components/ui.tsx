import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { api } from '../api';

/** "1 profile", "3 profiles". */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** First letter of the part of a label that tells profiles apart ("Claude Code · Work" → "W"); matches core's labelInitial. */
export const labelInitial = (label: string) => (label.split('·').pop() ?? label).replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase();

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    default: 'bg-panel border border-line hover:border-muted',
    primary: 'bg-accent text-accent-text border border-transparent hover:brightness-110',
    ghost: 'border border-transparent hover:bg-line/60',
    danger: 'bg-panel border border-bad/50 text-bad hover:bg-bad/10',
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition disabled:opacity-50 disabled:pointer-events-none ${styles} ${className}`}
    />
  );
}

export function Chip({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; title?: string }) {
  const styles = {
    neutral: 'bg-line/70 text-muted',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad',
    info: 'bg-info/15 text-info',
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium whitespace-nowrap ${styles}`}>
      {children}
    </span>
  );
}

/** A profile's rendered icon (base app icon + badge), fetched from the main process. */
export function ProfileIcon({ id, size = 40, version = 0 }: { id: string; size?: number; version?: number }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    api.icon(id, size * 2).then((url) => live && setSrc(url)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, size, version]);
  return src ? (
    <img src={src} width={size} height={size} alt="" className="shrink-0" />
  ) : (
    <div style={{ width: size, height: size }} className="shrink-0 rounded-[22%] bg-line" />
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3 font-semibold">{title}</div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export interface ToastMsg {
  id: number;
  text: string;
  tone: 'ok' | 'bad' | 'info';
}

export function Toasts({ items }: { items: ToastMsg[] }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-md flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border px-3 py-2 text-[12.5px] shadow-lg bg-panel ${t.tone === 'bad' ? 'border-bad/60' : t.tone === 'ok' ? 'border-ok/60' : 'border-line'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-1 text-muted">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-72 flex-1">
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 max-w-2xl text-muted">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 gap-2">{actions}</div>
    </div>
  );
}
