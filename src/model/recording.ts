import { clamp, countLE } from './format';

/* A live session's `/metrics` time series. Every panel is a view of these numbers. */

export interface RawSample {
  t: number;
  m: Record<string, number>;
  // cumulative bucket counts keyed by the `le` string
  h: Record<string, Record<string, number>>;
  l: Record<string, Record<string, number>>;
  e: Record<string, Record<string, number>>;
}

export interface ScrapeLog {
  // unix time of t=0; sample times are relative to it
  t0Unix: number;
  model: string | null;
  info: Record<string, Record<string, string>>;
  engines: string[];
  samples: RawSample[];
}

export interface Edge {
  v: number;
  le: string;
}

export interface Row {
  t: number;
  m: Record<string, number>;
  h: Record<string, number[]>;
  l: Record<string, Record<string, number>>;
  // per engine core
  e: Record<string, Record<string, number>>;
  running: number;
  waiting: number;
  kv: number;
  steps: number;
  iterTok: number;
  gen: number;
  queries: number;
  hits: number;
  preempt: number;
  done: number;
  dt: number;
  dPreempt: number;
  stepsPerS: number;
  msPerStep: number | null;
  decodePerS: number;
  prefillPerS: number;
  tokPerStep: number | null;
  donePerS: number;
  hitRate: number | null;
  cPreempt: number;
  cDone: number;
  hitRateRun: number | null;
}

export type SmoothKey = 'kv' | 'stepsPerS' | 'prefillPerS' | 'decodePerS';

export interface Recording {
  // `_info` series by name, their labels the payload
  info: Record<string, Record<string, string>>;
  cache: Record<string, string>;
  model: string | null;
  rows: Row[];
  times: number[];
  have: Set<string>;
  edges: Record<string, Edge[]>;
  tEnd: number;
  interval: number;
  hasKv: boolean;
  blockSize: number;
  nBlocks: number;
  apc: boolean;
  engines: string[];
  // unix time of the first row
  t0Unix: number;
}

export interface HistWindow {
  edges: Edge[];
  cum: number[];
  n: number;
  mean: number | null;
}

const edgeOf = (le: string): number => (/^\+?inf$/i.test(le) ? Infinity : parseFloat(le));

const pick = (m: Record<string, number>, ...names: string[]): number => {
  for (const n of names) {
    if (m[n] != null) { return +m[n]; }
  }
  return 0;
};

// Bucket edges are collected across every sample rather than taken from the first: a
// histogram with no observations yet may not be exported at all
function collectEdges(samples: RawSample[]): Record<string, Edge[]> {
  const seen: Record<string, Set<string>> = {};
  for (const s of samples) {
    for (const [b, v] of Object.entries(s.h)) {
      const set = seen[b] ?? (seen[b] = new Set());
      for (const le of Object.keys(v)) { set.add(le); }
    }
  }
  const out: Record<string, Edge[]> = {};
  for (const [b, set] of Object.entries(seen)) {
    out[b] = [...set].map((le) => ({ v: edgeOf(le), le })).sort((a, z) => a.v - z.v);
  }
  return out;
}

function alignHist(s: RawSample, edges: Record<string, Edge[]>): Record<string, number[]> {
  const h: Record<string, number[]> = {};
  for (const [b, v] of Object.entries(s.h)) {
    const e = edges[b];
    if (e) { h[b] = e.map((x) => v[x.le] ?? 0); }
  }
  return h;
}

function makeRow(s: RawSample, edges: Record<string, Edge[]>): Row {
  const m = s.m;
  return {
    t: s.t,
    m,
    h: alignHist(s, edges),
    l: s.l,
    e: s.e,
    running: pick(m, 'num_requests_running'),
    waiting: pick(m, 'num_requests_waiting'),
    kv: pick(m, 'kv_cache_usage_perc', 'gpu_cache_usage_perc'),
    steps: pick(m, 'iteration_tokens_total_count'),
    iterTok: pick(m, 'iteration_tokens_total_sum'),
    gen: pick(m, 'generation_tokens_total'),
    queries: pick(m, 'prefix_cache_queries_total', 'gpu_prefix_cache_queries_total'),
    hits: pick(m, 'prefix_cache_hits_total', 'gpu_prefix_cache_hits_total'),
    preempt: pick(m, 'num_preemptions_total'),
    done: pick(m, 'request_success_total'),
    dt: 0, dPreempt: 0,
    stepsPerS: 0, msPerStep: null, decodePerS: 0, prefillPerS: 0, tokPerStep: null, donePerS: 0,
    hitRate: null, cPreempt: 0, cDone: 0, hitRateRun: null,
  };
}

// a scrape this long after the previous one follows a pause or an outage: no rate spans the gap
const GAP_S = 5;

function derive(rows: Row[]): void {
  const base = rows[0];
  rows.forEach((r, i) => {
    const p = i ? rows[i - 1] : r;
    // dt 0 marks a row that starts a stretch, like the first one
    const dt = i && r.t - p.t <= GAP_S ? Math.max(1e-9, r.t - p.t) : 0;
    const d = (k: 'steps' | 'iterTok' | 'gen' | 'preempt' | 'done' | 'queries' | 'hits') => (dt ? Math.max(0, r[k] - p[k]) : 0);
    const steps = d('steps');
    const decode = d('gen');
    // The iteration histogram counts every token that went through a forward pass;
    // whatever is not a generated token was prefill. The only place /metrics splits them
    const prefill = Math.max(0, d('iterTok') - decode);
    const queries = d('queries');
    r.dt = dt;
    r.dPreempt = d('preempt');
    r.stepsPerS = dt ? steps / dt : 0;
    r.msPerStep = steps > 0 ? (dt * 1e3) / steps : null;
    r.decodePerS = dt ? decode / dt : 0;
    r.prefillPerS = dt ? prefill / dt : 0;
    r.tokPerStep = steps > 0 ? d('iterTok') / steps : null;
    r.donePerS = dt ? d('done') / dt : 0;
    r.hitRate = queries > 0 ? d('hits') / queries : null;
    // Counters relative to the first scrape, so a session does not depend on how long the
    // server had been up before it connected
    r.cPreempt = r.preempt - base.preempt;
    r.cDone = r.done - base.done;
    const cQueries = r.queries - base.queries;
    r.hitRateRun = cQueries > 0 ? (r.hits - base.hits) / cQueries : null;
  });
}

export class RecordingProps {
  /* given the scrapes so far, build the recording. Throws on a log with no samples */
  static ingest(raw: ScrapeLog): Recording {
    if (!raw.samples.length) { throw new Error('No metric samples'); }
    const edges = collectEdges(raw.samples);
    const rows = raw.samples.map((s) => makeRow(s, edges)).sort((a, b) => a.t - b.t);
    const first = rows[0].t;
    for (const r of rows) { r.t -= first; }
    derive(rows);

    const have = new Set<string>();
    for (const r of rows) {
      for (const k of Object.keys(r.m)) { have.add(k); }
    }
    const cache = raw.info.cache_config_info ?? {};
    const blockSize = +cache.block_size || 16;
    const kvTokens = +cache.kv_cache_size_tokens || 0;
    const nBlocks = +cache.num_gpu_blocks || (kvTokens ? Math.round(kvTokens / blockSize) : 0);
    const last = rows[rows.length - 1];

    return {
      info: raw.info,
      cache,
      model: raw.model,
      rows,
      times: rows.map((r) => r.t),
      have,
      edges,
      tEnd: last.t,
      interval: rows.length > 1 ? Math.max(0.02, last.t / (rows.length - 1)) : 1,
      hasKv: have.has('kv_cache_usage_perc') || have.has('gpu_cache_usage_perc'),
      blockSize,
      nBlocks,
      engines: raw.engines,
      apc: String(cache.enable_prefix_caching ?? '').toLowerCase() === 'true',
      t0Unix: raw.t0Unix + first,
    };
  }

  /* Index of the last sample at or before t */
  static idxAt(rec: Recording, t: number): number {
    return clamp(countLE(rec.times, t) - 1, 0, rec.rows.length - 1);
  }

  /* Linear interpolation of a derived field, so the playhead moves smoothly */
  static interpAt(rec: Recording, key: SmoothKey, t: number): number {
    const R = rec.rows;
    const i = RecordingProps.idxAt(rec, t);
    if (i >= R.length - 1) { return R[R.length - 1][key]; }
    const a = R[i];
    const b = R[i + 1];
    const f = clamp((t - a.t) / Math.max(1e-9, b.t - a.t), 0, 1);
    return a[key] + (b[key] - a[key]) * f;
  }

  /* Prometheus buckets are cumulative, so a window is a difference of two snapshots */
  static histWindow(rec: Recording, base: string, i0: number, i1: number): HistWindow | null {
    const edges = rec.edges[base];
    const b = rec.rows[i1]?.h[base];
    if (!edges || !b) { return null; }
    const a = i0 >= 0 && i0 !== i1 ? rec.rows[i0].h[base] : undefined;
    const cum = b.map((v, k) => Math.max(0, v - (a ? a[k] : 0)));
    const n = cum[cum.length - 1] ?? 0;
    const sumOf = (i: number) => rec.rows[i]?.m[`${base}_sum`] ?? 0;
    const sum = Math.max(0, sumOf(i1) - (a ? sumOf(i0) : 0));
    return { edges, cum, n, mean: n ? sum / n : null };
  }

  /* samples [i0, i1] covering the last `s` seconds up to t */
  static windowAt(rec: Recording, t: number, s: number): [number, number] {
    const i1 = RecordingProps.idxAt(rec, t);
    let i0 = RecordingProps.idxAt(rec, t - s);
    // start after the last gap, so a rate never averages over a pause
    for (let k = i1; k > i0; k--) {
      if (!rec.rows[k].dt) { i0 = k; break; }
    }
    return [i0, i1];
  }

  /* per-second growth of a counter between two samples, pool-wide or for one engine core.
   * Null when the window holds a single sample */
  static rate(rec: Recording, metric: string, i0: number, i1: number, engine?: string): number | null {
    const a = rec.rows[i0];
    const b = rec.rows[i1];
    const dt = b.t - a.t;
    if (dt <= 0) { return null; }
    const at = (r: Row) => (engine == null ? r.m[metric] : r.e[engine]?.[metric]) ?? 0;
    return Math.max(0, at(b) - at(a)) / dt;
  }

  static quantile(w: HistWindow | null, q: number): number | null {
    if (!w || !w.n) { return null; }
    const target = q * w.n;
    for (let i = 0; i < w.cum.length; i++) {
      if (w.cum[i] < target) { continue; }
      const lo = i ? w.edges[i - 1].v : 0;
      const hi = w.edges[i].v;
      // in the overflow bucket: a lower bound only
      if (!Number.isFinite(hi)) { return lo; }
      const c0 = i ? w.cum[i - 1] : 0;
      return lo + ((target - c0) / Math.max(1e-9, w.cum[i] - c0)) * (hi - lo);
    }
    return w.edges[w.edges.length - 1].v;
  }
}
