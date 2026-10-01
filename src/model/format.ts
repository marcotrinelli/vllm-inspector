const DASH = '—';

const absent = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v);

export const fmt = (v: number | null | undefined, digits = 2): string => (absent(v) ? DASH : v.toFixed(digits));

export const pct = (v: number | null | undefined, digits = 1): string => (absent(v) ? DASH : `${(v * 100).toFixed(digits)}%`);

export const int = (v: number | null | undefined): string => (absent(v) ? DASH : Math.round(v).toLocaleString('en-US'));

/* Compact magnitude: 12.3k, 4.56M */
export const si = (v: number | null | undefined): string => {
  if (absent(v)) { return DASH; }
  const a = Math.abs(v);
  if (a >= 1e9) { return `${(v / 1e9).toFixed(2)}G`; }
  if (a >= 1e6) { return `${(v / 1e6).toFixed(2)}M`; }
  if (a >= 1e4) { return `${(v / 1e3).toFixed(1)}k`; }
  return int(v);
};

/* Seconds at whatever precision keeps it readable, from microseconds to minutes */
export const dur = (v: number | null | undefined): string => {
  if (absent(v)) { return DASH; }
  if (v === 0) { return '0'; }
  if (v >= 60) { return `${Math.floor(v / 60)}m ${(v % 60).toFixed(0)}s`; }
  if (v >= 1) { return `${v.toFixed(2)} s`; }
  if (v >= 1e-3) { return `${(v * 1e3).toFixed(v >= 0.1 ? 0 : 1)} ms`; }
  return `${(v * 1e6).toFixed(0)} µs`;
};

/* The next 1, 2 or 5 step at or above v, for an axis maximum */
export const niceMax = (v: number): number => {
  if (!Number.isFinite(v) || v <= 0) { return 1; }
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
};

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/* Number of elements <= v in a sorted array */
export function countLE(arr: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) { lo = mid + 1; } else { hi = mid; }
  }
  return lo;
}
