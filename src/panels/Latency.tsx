import { useMemo, useState, type MouseEvent } from 'react';

import { useTip, useWidth } from '../components/hooks';
import { Info, Row, Stat } from '../components/ui';
import { clamp, dur, int, niceMax } from '../model/format';
import { RecordingProps, type Recording } from '../model/recording';
import { PALETTE } from '../theme';

const H = 160;
const PAD = { l: 52, r: 8, t: 8, b: 18 };
const GRID = 3;
// each point is the distribution of the requests observed in the WINDOW_S before it
const WINDOW_S = 15;
// histogram -> label, in picker order
const LATENCIES: Record<string, string> = {
  time_to_first_token_seconds: 'time to first token',
  inter_token_latency_seconds: 'inter-token latency',
  e2e_request_latency_seconds: 'end-to-end latency',
  request_queue_time_seconds: 'queue time',
  request_prefill_time_seconds: 'prefill time',
  request_decode_time_seconds: 'decode time',
  request_time_per_output_token_seconds: 'time per output token',
};
// p99 is dashed: amber and coral alone are too close to tell apart
const LINES = [
  { q: 0.5, label: 'p50', color: PALETTE.accent, dash: undefined },
  { q: 0.95, label: 'p95', color: PALETTE.waiting, dash: undefined },
  { q: 0.99, label: 'p99', color: PALETTE.critical, dash: '4 3' },
];

interface Point {
  t: number;
  n: number;
  v: Array<number | null>;
}

function series(rec: Recording, base: string, x0: number, x1: number): Point[] {
  const out: Point[] = [];
  rec.rows.forEach((r, i) => {
    if (r.t < x0 || r.t > x1) { return; }
    const i0 = RecordingProps.idxAt(rec, r.t - WINDOW_S);
    const w = i0 < i ? RecordingProps.histWindow(rec, base, i0, i) : null;
    out.push({ t: r.t, n: w?.n ?? 0, v: LINES.map((l) => RecordingProps.quantile(w, l.q)) });
  });
  return out;
}

interface Props {
  rec: Recording;
  t: number;
  x0: number;
  x1: number;
}

/* Latency quantiles over time, from the server's own histogram buckets */
const Latency = ({ rec, t, x0, x1 }: Props) => {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const { tip, place, clear, style } = useTip<Point>(wrapRef);
  const [picked, setPicked] = useState('time_to_first_token_seconds');
  const options = Object.keys(LATENCIES).filter((b) => rec.edges[b]);
  const base = options.includes(picked) ? picked : options[0];
  const points = useMemo(() => (base ? series(rec, base, x0, x1) : []), [rec, base, x0, x1]);

  const [i0, i1] = RecordingProps.windowAt(rec, t, WINDOW_S);
  const now = base && i0 < i1 ? RecordingProps.histWindow(rec, base, i0, i1) : null;
  const yMax = niceMax(Math.max(1e-3, ...points.flatMap((p) => p.v.filter((v): v is number => v != null))));
  const X = (v: number) => PAD.l + clamp((v - x0) / Math.max(1e-9, x1 - x0), 0, 1) * (width - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - Math.min(v, yMax) / yMax) * (H - PAD.t - PAD.b);
  const clock = (v: number) => new Date((rec.t0Unix + v) * 1000).toLocaleTimeString([], { hour12: false });

  const path = (k: number) => {
    let d = '';
    let pen = 'M';
    for (const p of points) {
      const v = p.v[k];
      if (v == null) { pen = 'M'; continue; }
      d += `${pen}${X(p.t).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = 'L';
    }
    return d;
  };

  const handleMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const v = x0 + ((e.clientX - box.left - PAD.l) / Math.max(1, box.width - PAD.l - PAD.r)) * (x1 - x0);
    let best: Point | null = null;
    for (const p of points) {
      if (!best || Math.abs(p.t - v) < Math.abs(best.t - v)) { best = p; }
    }
    if (best) { place(e, best); } else { clear(); }
  };

  if (!base) { return <div className="hint">This server exports no latency histograms</div>; }
  const shown = tip ?? points[points.length - 1];

  return (
    <>
      <div className="legend top">
        <select value={base} onChange={(e) => setPicked(e.target.value)} aria-label="Latency">
          {options.map((b) => <option key={b} value={b}>{LATENCIES[b]}</option>)}
        </select>
        <Info text={`Quantiles from the server's own histogram buckets. Each point covers the observations in the ${WINDOW_S} s before it, so a quiet stretch reads as a gap, not as zero. The top bucket is unbounded: a quantile landing in it is reported at its lower edge. Hover the chart for the time and the values.`} />
      </div>
      <div className="stats">
        <Stat label="observed" value={int(now?.n ?? 0)} />
        <Stat label="mean" value={dur(now?.mean)} />
        {LINES.map((l) => <Stat key={l.label} label={l.label} value={dur(RecordingProps.quantile(now, l.q))} />)}
      </div>
      <div className="hoverwrap" ref={wrapRef}>
        <svg className="chart" width={width} height={H} role="img" aria-label={`${LATENCIES[base]} over time`}
          onMouseMove={handleMove} onMouseLeave={clear}>
          {Array.from({ length: GRID + 1 }, (_, g) => {
            const v = (yMax / GRID) * g;
            return (
              <g key={g}>
                <line x1={PAD.l} x2={width - PAD.r} y1={Y(v)} y2={Y(v)} stroke={g ? PALETTE.line : PALETTE.axis} />
                <text x={PAD.l - 6} y={Y(v) + 3} textAnchor="end" className="axis">{dur(v)}</text>
              </g>
            );
          })}
          <text x={PAD.l} y={H - 3} className="axis">{clock(x0)}</text>
          <text x={width - PAD.r} y={H - 3} textAnchor="end" className="axis">{clock(x1)}</text>
          {LINES.map((l, k) => <path key={l.label} d={path(k)} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray={l.dash} strokeLinejoin="round" />)}
          <line x1={X(t)} x2={X(t)} y1={PAD.t} y2={H - PAD.b} stroke={PALETTE.text} strokeWidth={1.5} />
          {tip && (
            <g>
              <line x1={X(tip.t)} x2={X(tip.t)} y1={PAD.t} y2={H - PAD.b} stroke={PALETTE.muted} />
              {LINES.map((l, k) => tip.v[k] != null && <circle key={l.label} cx={X(tip.t)} cy={Y(tip.v[k] ?? 0)} r={4} fill={l.color} stroke={PALETTE.panel} strokeWidth={2} />)}
            </g>
          )}
        </svg>
        <div className="chart-legend">
          {LINES.map((l, k) => (
            <span key={l.label}>
              <i style={{ background: l.color }} />{l.label}<b>{dur(shown?.v[k])}</b>
            </span>
          ))}
          <span className="chart-stamp">{shown ? clock(shown.t) : ''}</span>
        </div>
        {tip && (
          <div className="tip" style={style}>
            <h4>{clock(tip.t)}<span className="sub">last {WINDOW_S} s</span></h4>
            {LINES.map((l, k) => <Row key={l.label} k={l.label} v={dur(tip.v[k])} />)}
            <Row k="observed" v={int(tip.n)} />
          </div>
        )}
      </div>
    </>
  );
};

export default Latency;
