import type { ReactNode } from 'react';

export type Tone = 'plain' | 'good' | 'warn' | 'bad';

interface CardProps {
  title: string;
  count?: string;
  note?: string;
  children: ReactNode;
}

/* An (i) that explains what sits next to it, on hover or keyboard focus */
export const Info = ({ text }: { text: string }) => (
  <span className="info" tabIndex={0} aria-label={text}>
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="7.3" y="7" width="1.4" height="4.6" rx="0.7" fill="currentColor" />
      <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
    </svg>
    <span className="info-tip" role="tooltip">{text}</span>
  </span>
);

export const Card = ({ title, count, note, children }: CardProps) => (
  <section className="card" role="region" aria-label={title}>
    <header>
      <h2>{title}{note && <Info text={note} />}</h2>
      {count && <span className="chip">{count}</span>}
    </header>
    <div className="card-body">{children}</div>
  </section>
);

interface SegProps<T> {
  // undefined: no option pressed
  value: T | undefined;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  label: string;
}

export const Seg = <T,>({ value, options, onChange, label }: SegProps<T>) => (
  <div className="seg" role="group" aria-label={label}>
    {options.map(([v, text]) => (
      <button key={text} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
    ))}
  </div>
);

export const Row = ({ k, v, tone }: { k: string; v: ReactNode; tone?: Tone }) => (
  <div className="kv"><span>{k}</span><b className={tone && tone !== 'plain' ? `tone-${tone}` : undefined}>{v}</b></div>
);

export const Stat = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
  <div className="stat">
    <strong>{value}{unit && <small>{unit}</small>}</strong>
    <span>{label}</span>
  </div>
);

export const Legend = ({ items, top }: { items: Array<[string, string]>; top?: boolean }) => (
  <div className={top ? 'legend top' : 'legend'}>
    {items.map(([color, label]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
  </div>
);

export const BusyCard = ({ status, detail }: { status: string; detail: string }) => (
  <div className="state-card">
    <div className="spinner" />
    <strong>{status}</strong>
    <span>{detail}</span>
  </div>
);

export const ErrorCard = ({ message }: { message: string }) => (
  <div className="state-card bad" role="alert">
    <strong>{message}</strong>
  </div>
);
