import { dur, fmt } from '../model/format';
import { INSPECTOR, LIVE_WINDOWS, type InspectorState } from '../store/InspectorStore';
import { Seg } from './ui';

const windowLabel = (s: number | null) => (s == null ? 'all' : s >= 60 ? `${s / 60} min` : `${s} s`);

const PauseIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" /></svg>
);

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7z" fill="currentColor" /></svg>
);

/* status dot (amber when paused or scrubbed back) and the server, with the scrape error beside it */
const LiveStatus = ({ state }: { state: InspectorState }) => {
  const live = state.live;
  if (!live) { return null; }
  const dot = live.error ? 'bad' : live.paused || !state.follow ? 'paused' : 'live';
  return (
    <span className="status" role="status" title={live.error || (live.paused ? 'polling paused' : live.url)}>
      <span className="dot" data-state={dot} />
      <span className="host">{live.url.replace(/^https?:\/\//, '')}</span>
      {live.error && <span className="chip" data-tone="bad">{live.error}</span>}
    </span>
  );
};

const Transport = ({ state }: { state: InspectorState }) => {
  const { rec, t, follow, windowS, range } = state;
  if (!rec) { return null; }
  const behind = rec.tEnd - t;
  return (
    <div className="topbar-row">
      <button type="button" className={follow ? 'primary' : undefined} aria-pressed={follow} onClick={() => INSPECTOR.setFollow(!follow)}>
        {follow ? 'Live' : 'Go live'}
      </button>
      <Seg label="Window" value={range ? undefined : windowS} onChange={(v) => INSPECTOR.setWindow(v)} options={LIVE_WINDOWS.map((s) => [s, windowLabel(s)])} />
      <input className="scrub" type="range" min={0} max={rec.tEnd || 1} step={0.01} value={t} aria-label="Time"
        onChange={(e) => INSPECTOR.seek(Number(e.target.value))} />
      {range && (
        <span className="chip" title={`${fmt(range[0], 1)} s – ${fmt(range[1], 1)} s into the session`}>
          <b>{dur(range[1] - range[0])}</b> selected
          <button type="button" aria-label="Clear selection" onClick={() => INSPECTOR.clearRange()}>×</button>
        </span>
      )}
      <span className="clock">
        {follow ? <b>now</b> : <><b>{fmt(behind, 1)} s</b> behind</>}
      </span>
    </div>
  );
};

const TopBar = ({ state }: { state: InspectorState }) => {
  const { rec, live, server } = state;
  if (!rec || !live) { return null; }
  return (
    <header className="topbar">
      <div className="topbar-row">
        <LiveStatus state={state} />
        {rec.model && <span className="chip">{rec.model}</span>}
        {server.version && <span className="chip">v{server.version}</span>}
        {rec.engines.length > 1 && <span className="chip">{rec.engines.length} engine cores</span>}
        <span className="grow" />
        <button type="button" className="icon" aria-label={live.paused ? 'Resume polling' : 'Pause polling'} title={live.paused ? 'Resume polling' : 'Pause polling'}
          onClick={() => (live.paused ? INSPECTOR.resume() : INSPECTOR.pause())}>
          {live.paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button type="button" onClick={() => INSPECTOR.disconnect()}>Disconnect</button>
      </div>
      <Transport state={state} />
    </header>
  );
};

export default TopBar;
