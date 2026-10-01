import type { MouseEvent } from 'react';

import { useTip, useWidth } from '../components/hooks';
import { Info, Legend, Row, Stat } from '../components/ui';
import { dur, fmt, int, pct, si } from '../model/format';
import { RecordingProps, type Recording, type Row as Sample } from '../model/recording';
import type { ServerFacts } from '../model/server';
import { PALETTE } from '../theme';

const PLOT_H = 150;
const PAD = { l: 38, r: 8, t: 8, b: 20 };
const DOT_R = 4;
const HIT_R = 14;

// a request's time, in the order it spends it
const STAGES: Array<{ hist: string; label: string; color: string }> = [
  { hist: 'request_queue_time_seconds', label: 'queued', color: PALETTE.waiting },
  { hist: 'request_prefill_time_seconds', label: 'prefill', color: PALETTE.prefill },
  { hist: 'request_decode_time_seconds', label: 'decode', color: PALETTE.decode },
];

/* v rounded up to a quarter of its decade: 1,050 -> 1,250, where niceMax would give 2,000 */
const axisMax = (v: number): number => {
  const step = 10 ** Math.floor(Math.log10(Math.max(1, v))) / 4;
  return Math.ceil(v / step) * step;
};

interface Point {
  x: number;
  y: number;
  row: Sample;
}

interface ScatterProps {
  title: string;
  points: Point[];
  current: Point | null;
  xMax: number;
  // max_num_seqs, drawn as the wall the batch cannot grow past
  xLimit: number | null;
  color: string;
  clock: (t: number) => string;
}

/* One dot per scrape: how big the batch was against what it produced */
const Scatter = ({ title, points, current, xMax, xLimit, color, clock }: ScatterProps) => {
  const [wrapRef, width] = useWidth<HTMLDivElement>(320);
  const { tip, place, clear, style } = useTip<Point>(wrapRef);
  const yMax = axisMax(Math.max(1, ...points.map((p) => p.y)));
  const X = (v: number) => PAD.l + (v / xMax) * (width - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - v / yMax) * (PLOT_H - PAD.t - PAD.b);

  const handleMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    let best: Point | null = null;
    let bestD = HIT_R * HIT_R;
    for (const p of points) {
      const d = (X(p.x) - mx) ** 2 + (Y(p.y) - my) ** 2;
      if (d < bestD) { best = p; bestD = d; }
    }
    if (best) { place(e, best); } else { clear(); }
  };

  return (
    <div className="hoverwrap" ref={wrapRef}>
      <h3 className="sub">{title}</h3>
      <svg className="chart" width={width} height={PLOT_H} role="img" aria-label={title} onMouseMove={handleMove} onMouseLeave={clear}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={width - PAD.r} y1={Y(f * yMax)} y2={Y(f * yMax)} stroke={f ? PALETTE.line : PALETTE.axis} />
            <text x={PAD.l - 6} y={Y(f * yMax) + 4} textAnchor="end" className="axis">{si(f * yMax)}</text>
          </g>
        ))}
        {[0, 0.5, 1].map((f) => <text key={f} x={X(f * xMax)} y={PLOT_H - 4} textAnchor={f ? (f === 1 ? 'end' : 'middle') : 'start'} className="axis">{int(f * xMax)}</text>)}
        {xLimit != null && <line x1={X(xLimit)} x2={X(xLimit)} y1={PAD.t} y2={PLOT_H - PAD.b} stroke={PALETTE.text2} strokeDasharray="3 3" />}
        {points.map((p) => <circle key={p.row.t} cx={X(p.x)} cy={Y(p.y)} r={DOT_R} fill={color} opacity={0.45} />)}
        {current && <circle cx={X(current.x)} cy={Y(current.y)} r={DOT_R + 2} fill={color} stroke={PALETTE.text} strokeWidth={2} />}
        {tip && <circle cx={X(tip.x)} cy={Y(tip.y)} r={DOT_R + 3} fill="none" stroke={PALETTE.text} strokeWidth={1.5} />}
      </svg>
      {tip && (
        <div className="tip" style={style}>
          <h4>{clock(tip.row.t)}</h4>
          <Row k="running" v={int(tip.row.running)} />
          <Row k="decode tok/s" v={si(tip.row.decodePerS)} />
          <Row k="tok/s per request" v={fmt(tip.row.decodePerS / Math.max(1, tip.row.running), 1)} />
          <Row k="ms per step" v={tip.row.msPerStep == null ? '—' : fmt(tip.row.msPerStep, 1)} />
          <Row k="tokens per step" v={tip.row.tokPerStep == null ? '—' : fmt(tip.row.tokPerStep, 0)} />
        </div>
      )}
    </div>
  );
};

/* Mean time per stage of the requests that finished in the window */
const Lifecycle = ({ rec, i0, i1 }: { rec: Recording; i0: number; i1: number }) => {
  if (i0 >= i1) { return <div className="hint">No request finished in this window</div>; }
  const stages = STAGES.map((s) => ({ ...s, w: RecordingProps.histWindow(rec, s.hist, i0, i1) }));
  const n = stages[stages.length - 1].w?.n ?? 0;
  const means = stages.map((s) => s.w?.mean ?? 0);
  const total = means.reduce((a, v) => a + v, 0);
  if (!n || !total) { return <div className="hint">No request finished in this window</div>; }
  return (
    <>
      <div className="stack" role="img" aria-label="Request lifecycle">
        {stages.map((s, i) => means[i] > 0 && <i key={s.hist} style={{ flexGrow: means[i], background: s.color }} />)}
      </div>
      <Legend items={stages.map((s, i) => [s.color, `${s.label} ${dur(means[i])} (${pct(means[i] / total, 0)})`])} />
    </>
  );
};

interface Props {
  rec: Recording;
  server: ServerFacts;
  t: number;
  x0: number;
}

/* Continuous batching as it ran: batch size against throughput, the per-step token budget,
 * and where a request's time goes */
const Scheduler = ({ rec, server, t, x0 }: Props) => {
  const cfg = server.config;
  const i1 = RecordingProps.idxAt(rec, t);
  const i0 = RecordingProps.idxAt(rec, x0);
  const row = rec.rows[i1];
  const seen = rec.rows.slice(i0, i1 + 1).filter((r) => r.running >= 1 && r.dt > 0 && r.decodePerS > 0);
  const total = seen.map((r) => ({ x: r.running, y: r.decodePerS, row: r }));
  const each = seen.map((r) => ({ x: r.running, y: r.decodePerS / r.running, row: r }));
  const at = seen[seen.length - 1] === row ? seen.length - 1 : -1;
  // max_num_seqs bounds each engine core; the running count here is summed over them
  const limit = cfg?.maxNumSeqs == null ? null : cfg.maxNumSeqs * Math.max(1, rec.engines.length);
  // the limit a stale config reports can sit below what the batch actually reached
  const xMax = axisMax(Math.max(8, limit ?? 0, ...seen.map((r) => r.running)));
  const clock = (v: number) => new Date((rec.t0Unix + v) * 1000).toLocaleTimeString([], { hour12: false });
  const budget = cfg?.maxNumBatchedTokens ?? null;

  return (
    <>
      <div className="stats">
        <Stat label="running" value={int(row.running)} unit={limit ? ` / ${int(limit)} seqs` : undefined} />
        <Stat label="tokens per step" value={row.tokPerStep == null ? '—' : fmt(row.tokPerStep, 0)} unit={budget ? ` / ${si(budget)}` : undefined} />
        <Stat label="ms per step" value={row.msPerStep == null ? '—' : fmt(row.msPerStep, 1)} />
        <Stat label="engine steps" value={fmt(RecordingProps.interpAt(rec, 'stepsPerS', t), 1)} unit="/s" />
      </div>
      {seen.length ? (
        <div className="pair">
          <Scatter title="decode tok/s vs running requests" points={total} current={at >= 0 ? total[at] : null}
            xMax={xMax} xLimit={limit} color={PALETTE.decode} clock={clock} />
          <Scatter title="tok/s per request vs running requests" points={each} current={at >= 0 ? each[at] : null}
            xMax={xMax} xLimit={limit} color={PALETTE.running} clock={clock} />
        </div>
      ) : (
        <div className="hint">No decoding in this window</div>
      )}
      {limit != null && <div className="legend"><span><i className="line" style={{ background: PALETTE.text2 }} />max_num_seqs</span></div>}
      <h3 className="sub">Where a request's time went<Info text="Mean time in each stage for the requests that finished in the visible window: queued (waiting for a batch slot or KV blocks), prefill (prompt through the forward pass), decode (one token per step until done)." /></h3>
      <Lifecycle rec={rec} i0={i0} i1={i1} />
    </>
  );
};

export default Scheduler;
