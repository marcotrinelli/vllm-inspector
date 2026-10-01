import { dur, fmt, int, pct, si } from '../model/format';
import { RecordingProps, type Recording, type Row } from '../model/recording';
import { PALETTE } from '../theme';
import type { Tone } from './ui';

// rates and quantiles over this much history, so a KPI does not flicker scrape to scrape
const WINDOW_S = 15;
const SPARK_SAMPLES = 90;
const SPARK_W = 100;
const SPARK_BOX = 10;
const KV_PRESSURE = 0.92;

const Spark = ({ values, color }: { values: number[]; color: string }) => {
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = SPARK_W / Math.max(1, values.length - 1);
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(2)} ${(SPARK_BOX - ((v - min) / span) * SPARK_BOX).toFixed(2)}`).join('');
  return (
    <svg className="spark" viewBox={`0 0 ${SPARK_W} ${SPARK_BOX}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

interface KpiProps {
  label: string;
  value: string;
  sub: string;
  color: string;
  spark?: number[];
  tone?: Tone;
}

const Kpi = ({ label, value, sub, color, spark, tone = 'plain' }: KpiProps) => (
  <div className="kpi" data-tone={tone}>
    <span className="kpi-label">{label}</span>
    <strong style={{ color }}>{value}</strong>
    <span className="kpi-sub">{sub}</span>
    {spark && spark.length > 1 && <Spark values={spark} color={color} />}
  </div>
);

/* The engine at the playhead: gauges as sampled, counters as rates over the last WINDOW_S */
const KpiStrip = ({ rec, t }: { rec: Recording; t: number }) => {
  const [i0, i1] = RecordingProps.windowAt(rec, t, WINDOW_S);
  const row = rec.rows[i1];
  const recent = rec.rows.slice(Math.max(0, i1 - SPARK_SAMPLES + 1), i1 + 1);
  const spark = (pick: (r: Row) => number) => recent.map(pick);
  const rate = (metric: string) => RecordingProps.rate(rec, metric, i0, i1);
  const perS = (v: number | null, digits = 0) => (v == null ? '—' : `${v >= 1e4 ? si(v) : fmt(v, digits)}/s`);

  const ttft = RecordingProps.histWindow(rec, 'time_to_first_token_seconds', i0, i1);
  const itl = RecordingProps.histWindow(rec, 'inter_token_latency_seconds', i0, i1);
  const steps = rate('iteration_tokens_total_count');
  const stepTokens = rate('iteration_tokens_total_sum');
  const decode = rate('generation_tokens_total');
  const queries = rate('prefix_cache_queries_total');
  const hits = rate('prefix_cache_hits_total');
  const done = rate('request_success_total');
  const preempt = rate('num_preemptions_total') ?? 0;
  const reasons = Object.entries(row.l.num_requests_waiting_by_reason ?? {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k.replace('reason=', '')} ${int(v)}`)
    .join(' · ');
  const cores = rec.engines.length;

  return (
    <div className="kpis">
      <Kpi label="Running" value={int(row.running)} sub={cores > 1 ? `across ${cores} engine cores` : 'in the batch'}
        color={PALETTE.running} spark={spark((r) => r.running)} />
      <Kpi label="Waiting" value={int(row.waiting)} sub={reasons || 'queue empty'}
        color={PALETTE.waiting} tone={row.waiting ? 'warn' : 'plain'} spark={spark((r) => r.waiting)} />
      <Kpi label="KV cache" value={rec.hasKv ? pct(row.kv) : '—'}
        sub={rec.nBlocks ? `${int(rec.nBlocks)} blocks${cores > 1 ? ' per core' : ''}` : 'pool size unknown'}
        color={PALETTE.kv} tone={row.kv > KV_PRESSURE ? 'bad' : 'plain'} spark={spark((r) => r.kv)} />
      <Kpi label="Output" value={perS(decode)} sub="generated tokens"
        color={PALETTE.decode} spark={spark((r) => r.decodePerS)} />
      <Kpi label="Prefill" value={perS(stepTokens == null || decode == null ? null : Math.max(0, stepTokens - decode))} sub="prompt tokens"
        color={PALETTE.prefill} spark={spark((r) => r.prefillPerS)} />
      <Kpi label="TTFT p95" value={dur(RecordingProps.quantile(ttft, 0.95))} sub={`p50 ${dur(RecordingProps.quantile(ttft, 0.5))}`}
        color={PALETTE.accent} />
      <Kpi label="Inter-token p95" value={dur(RecordingProps.quantile(itl, 0.95))} sub={`p50 ${dur(RecordingProps.quantile(itl, 0.5))}`}
        color={PALETTE.accent} />
      <Kpi label="Prefix hits" value={queries ? pct((hits ?? 0) / queries) : '—'}
        sub={`${row.hitRateRun == null ? '—' : pct(row.hitRateRun)} since connect`} color={PALETTE.hit} />
      <Kpi label="Finished" value={perS(done, 1)} sub={`${si(row.cDone)} since connect`}
        color={PALETTE.running} spark={spark((r) => r.donePerS)} />
      <Kpi label="Preemptions" value={perS(preempt, 1)} sub={preempt > 0 ? 'KV pressure, sequences recomputed' : `${int(row.cPreempt)} since connect`}
        color={preempt > 0 ? PALETTE.preempted : PALETTE.muted} tone={preempt > 0 ? 'bad' : 'plain'} spark={spark((r) => (r.dt ? r.dPreempt / r.dt : 0))} />
      <Kpi label="Engine steps" value={perS(steps, 1)} sub={steps && stepTokens ? `${int(stepTokens / steps)} tokens/step` : 'idle'}
        color={PALETTE.accent} spark={spark((r) => r.stepsPerS)} />
    </div>
  );
};

export default KpiStrip;
