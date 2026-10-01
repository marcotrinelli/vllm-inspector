import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import { useTip } from '../components/hooks';
import { Legend, Row } from '../components/ui';
import { clamp, dur, fmt, int, niceMax, pct, si } from '../model/format';
import type { Recording, Row as Sample } from '../model/recording';
import { alpha, PALETTE } from '../theme';

const W = 1000;
const KV_H = 58;
const TOK_H = 54;
const BATCH_H = 44;
const GAP = 10;
const TICK_H = 5;
const TOK_TOP = KV_H + GAP;
const BATCH_TOP = TOK_TOP + TOK_H + GAP;
const H = BATCH_TOP + BATCH_H + TICK_H + 3;
const MAX_BINS = 500;
const AXIS_TICKS = 6;
// a press that moves less than this is a click on the playhead, not a range
const DRAG_PX = 4;

interface Bin {
  t0: number;
  t1: number;
  kv: number;
  running: number;
  waiting: number;
  prefill: number;
  decode: number;
  preempt: number;
  last: Sample;
}

/* given the rows inside [x0, x1], at most MAX_BINS columns: gauges keep their peak, rates
 * their time-weighted mean, counts their sum */
function binRows(rows: Sample[], x0: number, x1: number): Bin[] {
  const inside = rows.filter((r) => r.t >= x0 && r.t <= x1);
  if (!inside.length) { return []; }
  const n = Math.min(inside.length, MAX_BINS);
  const span = Math.max(1e-9, x1 - x0);
  const bins: Bin[] = [];
  let i = 0;
  for (let b = 0; b < n; b++) {
    const end = n === inside.length ? inside[b].t : x0 + ((b + 1) / n) * span;
    const members: Sample[] = [];
    while (i < inside.length && (inside[i].t <= end || members.length === 0)) { members.push(inside[i++]); }
    if (!members.length) { continue; }
    const dt = members.reduce((a, r) => a + r.dt, 0) || 1;
    bins.push({
      t0: members[0].t - members[0].dt,
      t1: members[members.length - 1].t,
      kv: Math.max(...members.map((r) => r.kv)),
      running: Math.max(...members.map((r) => r.running)),
      waiting: Math.max(...members.map((r) => r.waiting)),
      prefill: members.reduce((a, r) => a + r.prefillPerS * r.dt, 0) / dt,
      decode: members.reduce((a, r) => a + r.decodePerS * r.dt, 0) / dt,
      preempt: members.reduce((a, r) => a + r.dPreempt, 0),
      last: members[members.length - 1],
    });
  }
  return bins;
}

interface Props {
  rec: Recording;
  t: number;
  x0: number;
  x1: number;
  onScrub: (t: number) => void;
  onRange: (a: number, b: number) => void;
}

interface Drag {
  px: number;
  v0: number;
  v1: number;
  moved: boolean;
}

const Timeline = ({ rec, t, x0, x1, onScrub, onRange }: Props) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { tip, place, clear, style } = useTip<Bin>(wrapRef);
  const bins = useMemo(() => binRows(rec.rows, x0, x1), [rec, x0, x1]);
  const X = (v: number) => (W * clamp((v - x0) / Math.max(1e-9, x1 - x0), 0, 1));

  // the chart body only changes with the data; the playhead moves over it every frame
  const body = useMemo(() => {
    const tokMax = niceMax(Math.max(...bins.map((b) => b.prefill + b.decode), 1));
    const seqMax = niceMax(Math.max(...bins.map((b) => b.running + b.waiting), 1));
    let line = '';
    for (const b of bins) { line += `${line ? ' L' : 'M'} ${X((b.t0 + b.t1) / 2).toFixed(2)} ${(KV_H - clamp(b.kv, 0, 1) * KV_H).toFixed(2)}`; }
    const area = bins.length ? `${line} L ${X((bins[bins.length - 1].t0 + bins[bins.length - 1].t1) / 2)} ${KV_H} L ${X((bins[0].t0 + bins[0].t1) / 2)} ${KV_H} Z` : '';
    return {
      tokMax,
      seqMax,
      svg: (
        <g>
          <line x1={0} x2={W} y1={KV_H} y2={KV_H} stroke={PALETTE.axis} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={0} y2={0} stroke={PALETTE.line} vectorEffect="non-scaling-stroke" />
          <path d={area} fill={alpha(PALETTE.kv, 0.1)} />
          <path d={line} fill="none" stroke={PALETTE.kv} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={TOK_TOP + TOK_H} y2={TOK_TOP + TOK_H} stroke={PALETTE.axis} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={BATCH_TOP + BATCH_H} y2={BATCH_TOP + BATCH_H} stroke={PALETTE.axis} vectorEffect="non-scaling-stroke" />
          {bins.map((b, i) => {
            const xa = X(b.t0);
            const w = Math.max(0.6, X(b.t1) - xa);
            const hd = (b.decode / tokMax) * TOK_H;
            const hp = (b.prefill / tokMax) * TOK_H;
            const hr = (b.running / seqMax) * BATCH_H;
            const hw = (b.waiting / seqMax) * BATCH_H;
            return (
              <g key={i}>
                <rect x={xa} y={TOK_TOP + TOK_H - hd} width={w} height={hd} fill={PALETTE.decode} />
                <rect x={xa} y={TOK_TOP + TOK_H - hd - hp} width={w} height={hp} fill={PALETTE.prefill} />
                <rect x={xa} y={BATCH_TOP + BATCH_H - hr} width={w} height={hr} fill={PALETTE.running} />
                <rect x={xa} y={BATCH_TOP + BATCH_H - hr - hw} width={w} height={hw} fill={PALETTE.waiting} />
                {b.preempt > 0 && <rect x={xa} y={BATCH_TOP + BATCH_H + 3} width={Math.max(2, w)} height={TICK_H} fill={PALETTE.preempted} />}
              </g>
            );
          })}
        </g>
      ),
    };
  }, [bins, x0, x1]);

  const locate = (e: MouseEvent<SVGSVGElement>): { v: number; bin: Bin | null } | null => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) { return null; }
    // a captured drag keeps reporting past the edges
    const v = x0 + clamp((e.clientX - box.left) / box.width, 0, 1) * (x1 - x0);
    const bin = bins.find((b) => v <= b.t1) ?? bins[bins.length - 1] ?? null;
    return { v, bin };
  };

  const handleMove = (e: PointerEvent<SVGSVGElement>) => {
    const hit = locate(e);
    if (!hit) { return; }
    if (drag) {
      setDrag({ ...drag, v1: hit.v, moved: drag.moved || Math.abs(e.clientX - drag.px) >= DRAG_PX });
      clear();
    } else if (hit.bin) {
      place(e, hit.bin);
    }
  };

  const handleDown = (e: PointerEvent<SVGSVGElement>) => {
    const hit = locate(e);
    if (!hit || e.button !== 0) { return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ px: e.clientX, v0: hit.v, v1: hit.v, moved: false });
  };

  const handleUp = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag) { return; }
    const hit = locate(e);
    setDrag(null);
    if (!hit) { return; }
    if (drag.moved) { onRange(drag.v0, hit.v); } else { onScrub(hit.v); }
  };

  const clock = (v: number) => new Date((rec.t0Unix + v) * 1000).toLocaleTimeString([], { hour12: false });
  const ticks = Array.from({ length: AXIS_TICKS }, (_, i) => x0 + (i / (AXIS_TICKS - 1)) * (x1 - x0));
  const h = tip?.last;
  return (
    <div className="hoverwrap" ref={wrapRef}>
      <Legend top items={[
        [PALETTE.kv, 'KV cache'],
        [PALETTE.prefill, 'prefill tok/s'],
        [PALETTE.decode, 'decode tok/s'],
        [PALETTE.running, 'running'],
        [PALETTE.waiting, 'waiting'],
        [PALETTE.preempted, 'preemption'],
      ]} />
      <svg className="chart brushable" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H * 1.25 }}
        role="img" aria-label="Engine timeline"
        onPointerMove={handleMove} onPointerDown={handleDown} onPointerUp={handleUp}
        onPointerCancel={() => setDrag(null)} onPointerLeave={clear}>
        {body.svg}
        {drag?.moved && (
          <rect x={X(Math.min(drag.v0, drag.v1))} width={Math.abs(X(drag.v1) - X(drag.v0))} y={0} height={H}
            fill={alpha(PALETTE.accent, 0.18)} stroke={PALETTE.accent} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        <line x1={X(t)} x2={X(t)} y1={0} y2={H} stroke={PALETTE.text} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {tip && <line x1={X(tip.t1)} x2={X(tip.t1)} y1={0} y2={H} stroke={PALETTE.accent} strokeWidth={1} opacity={0.6} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="legend num" style={{ justifyContent: 'space-between' }}>
        {ticks.map((v) => <span key={v}>{clock(v)}</span>)}
      </div>
      <div className="legend num" style={{ marginTop: 2 }}>
        <span>KV 0–100%</span>
        <span>tok/s to {si(body.tokMax)}</span>
        <span>requests to {si(body.seqMax)}</span>
      </div>
      {drag?.moved && (
        <div className="brush-label" style={{ left: `${(X((drag.v0 + drag.v1) / 2) / W) * 100}%` }}>
          {clock(Math.min(drag.v0, drag.v1))} – {clock(Math.max(drag.v0, drag.v1))} · <b>{dur(Math.abs(drag.v1 - drag.v0))}</b>
        </div>
      )}
      {h && tip && (
        <div className="tip" style={style}>
          <h4>{clock(h.t)}{tip.t1 - tip.t0 > rec.interval * 1.5 && <span className="sub">peak over {dur(tip.t1 - tip.t0)}</span>}</h4>
          <Row k="KV cache" v={pct(tip.kv)} tone={tip.kv > 0.95 ? 'bad' : tip.kv > 0.8 ? 'warn' : 'plain'} />
          <Row k="running · waiting" v={`${int(tip.running)} · ${int(tip.waiting)}`} tone={tip.waiting ? 'warn' : 'plain'} />
          <Row k="prefill tok/s" v={si(tip.prefill)} />
          <Row k="decode tok/s" v={si(tip.decode)} />
          <Row k="ms per step" v={h.msPerStep == null ? '—' : fmt(h.msPerStep, 1)} />
          <Row k="tokens per step" v={h.tokPerStep == null ? '—' : fmt(h.tokPerStep, 0)} />
          <Row k="preemptions" v={int(tip.preempt)} tone={tip.preempt ? 'bad' : 'plain'} />
          <Row k="prefix hit" v={h.hitRate == null ? '—' : pct(h.hitRate)} />
        </div>
      )}
    </div>
  );
};

export default Timeline;
