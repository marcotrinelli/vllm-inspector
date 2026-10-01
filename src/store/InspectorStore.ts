import { useSyncExternalStore } from 'react';

import { ApiError, normalizeUrl, VllmClient } from '../api/inspector';
import { clamp } from '../model/format';
import { parseScrape, type Scrape } from '../model/prometheus';
import { RecordingProps, type RawSample, type Recording } from '../model/recording';
import { NO_FACTS, type ServerFacts } from '../model/server';

export interface LiveState {
  url: string;
  scrapes: number;
  error: string;
  restarts: number;
  // polling stopped by the user; the history stays
  paused: boolean;
}

export interface InspectorState {
  rec: Recording | null;
  live: LiveState | null;
  server: ServerFacts;
  t: number;
  // the playhead sits on the newest scrape
  follow: boolean;
  // seconds of history on screen, null for all of it
  windowS: number | null;
  // a range picked on the timeline, overriding windowS until cleared
  range: [number, number] | null;
  error: string;
  busy: string;
}

export const LIVE_WINDOWS: Array<number | null> = [60, 300, null];

const LIVE_INTERVAL_MS = 1000;
// two scrapes: anything narrower holds no rate
const MIN_RANGE_S = 2;
const FACTS_EVERY_TICKS = 30;
const LIVE_MAX_SAMPLES = 3600;
const URL_KEY = 'vllm-inspector.url';
// build-time default for the connect dialog, from .env
const DEFAULT_URL = import.meta.env.VITE_VLLM_URL || 'http://localhost:8000';

const INITIAL: InspectorState = {
  rec: null,
  live: null,
  server: NO_FACTS,
  t: 0,
  follow: true,
  windowS: 60,
  range: null,
  error: '',
  busy: '',
};

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked (private window): the URL is only a convenience
  }
}

interface LiveSession {
  client: VllmClient;
  // unix seconds of t=0; samples are stamped with the wall clock
  t0: number;
  samples: RawSample[];
  info: Scrape['info'];
  engines: string[];
  facts: ServerFacts;
  startedAt: number;
  ticks: number;
  timer: ReturnType<typeof setInterval> | null;
}

class InspectorStore {
  state: InspectorState = INITIAL;

  private listeners = new Set<() => void>();
  private session: LiveSession | null = null;
  private busy = false;
  // `/server_info` can take seconds on a loaded server; the scrape loop never waits for it
  private factsBusy = false;
  private started = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): InspectorState => this.state;

  private set(patch: Partial<InspectorState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) { fn(); }
  }

  get defaultUrl(): string {
    return this.state.live?.url || remembered(URL_KEY) || DEFAULT_URL;
  }

  /* Page load: honour ?live= */
  async init(): Promise<void> {
    // StrictMode runs mount effects twice in development
    if (this.started) { return; }
    this.started = true;
    const live = new URLSearchParams(location.search).get('live');
    if (!live) { return; }
    const error = await this.connect(live);
    if (error) { this.set({ error }); }
  }

  /* Playhead */

  seek(t: number): void {
    const rec = this.state.rec;
    if (!rec) { return; }
    const next = clamp(t, 0, rec.tEnd);
    // scrubbing back stops following; reaching the head resumes it, and the newest scrape
    // would fall outside a picked range
    const follow = next >= rec.tEnd - 1e-3;
    this.set({ t: next, follow, range: follow ? null : this.state.range });
  }

  step(dt: number): void {
    this.seek(this.state.t + dt);
  }

  setFollow(follow: boolean): void {
    this.set({ follow, t: follow && this.state.rec ? this.state.rec.tEnd : this.state.t, range: follow ? null : this.state.range });
  }

  setWindow(windowS: number | null): void {
    this.set({ windowS, range: null });
  }

  /* zoom to [a, b], either order, with the playhead on its end: a picked range is history */
  setRange(a: number, b: number): void {
    const rec = this.state.rec;
    if (!rec) { return; }
    const lo = clamp(Math.min(a, b), 0, rec.tEnd);
    const hi = clamp(Math.max(a, b), 0, rec.tEnd);
    if (hi - lo < MIN_RANGE_S) { return; }
    this.set({ range: [lo, hi], t: hi, follow: false });
  }

  clearRange(): void {
    this.set({ range: null });
  }

  /* Live */

  /* vLLM for /metrics. Returns an error string for the dialog, empty on success */
  async connect(raw: string): Promise<string> {
    const vllm = normalizeUrl(raw);
    if (vllm.error) { return vllm.error; }
    const client = new VllmClient(vllm.base);
    this.set({ busy: 'Connecting' });
    let text: string;
    try {
      text = await client.metrics();
    } catch (cause) {
      this.set({ busy: '' });
      return cause instanceof ApiError ? cause.message : message(cause);
    }
    this.disconnect();
    remember(URL_KEY, vllm.base);
    const session: LiveSession = {
      client, t0: Date.now() / 1000, samples: [], info: {}, engines: [], facts: NO_FACTS, startedAt: 0, ticks: 0, timer: null,
    };
    this.session = session;
    this.set({
      busy: '', error: '', rec: null, server: NO_FACTS, follow: true, t: 0, range: null,
      live: { url: vllm.base, scrapes: 0, error: '', restarts: 0, paused: false },
    });
    this.acceptScrape(session, text);
    void this.acceptFacts(session);
    this.startPolling(session);
    return '';
  }

  pause(): void {
    const s = this.session;
    if (!s?.timer) { return; }
    clearInterval(s.timer);
    s.timer = null;
    this.patchLive({ paused: true });
  }

  resume(): void {
    const s = this.session;
    if (!s || s.timer) { return; }
    this.startPolling(s);
    this.patchLive({ paused: false });
    void this.tick(s);
  }

  private startPolling(session: LiveSession): void {
    session.timer = setInterval(() => { void this.tick(session); }, LIVE_INTERVAL_MS);
  }

  disconnect(): void {
    const s = this.session;
    if (!s) { return; }
    if (s.timer) { clearInterval(s.timer); }
    this.session = null;
    this.set({ live: null, rec: null, server: NO_FACTS, t: 0, range: null });
  }

  private patchLive(patch: Partial<LiveState>): void {
    if (this.state.live) { this.set({ live: { ...this.state.live, ...patch } }); }
  }

  private async tick(session: LiveSession): Promise<void> {
    if (this.busy || this.session !== session || !session.timer) { return; }
    this.busy = true;
    try {
      const text = await session.client.metrics();
      // a scrape that lands after Pause is dropped, so the history ends where the user stopped it
      if (this.session !== session || !session.timer) { return; }
      session.ticks++;
      if (session.ticks % FACTS_EVERY_TICKS === 0) { void this.acceptFacts(session); }
      this.acceptScrape(session, text);
      this.patchLive({ error: '' });
    } catch (cause) {
      this.patchLive({ error: message(cause) });
    } finally {
      this.busy = false;
    }
  }

  private async acceptFacts(session: LiveSession): Promise<void> {
    if (this.factsBusy) { return; }
    this.factsBusy = true;
    try {
      const facts = await session.client.facts();
      if (this.session !== session) { return; }
      session.facts = facts;
      this.set({ server: facts });
    } finally {
      this.factsBusy = false;
    }
  }

  private acceptScrape(session: LiveSession, text: string): void {
    const s = parseScrape(text);
    // a restarted engine resets its counters; history across it would draw negative rates
    const started = s.m.process_start_time_seconds ?? 0;
    if (session.startedAt && started && started !== session.startedAt) {
      session.samples = [];
      this.patchLive({ restarts: (this.state.live?.restarts ?? 0) + 1 });
    }
    session.startedAt = started;
    session.info = { ...session.info, ...s.info };
    session.engines = s.engines;
    session.samples.push({ t: Date.now() / 1000 - session.t0, m: s.m, h: s.h, l: s.l, e: s.e });
    if (session.samples.length > LIVE_MAX_SAMPLES) { session.samples.splice(0, session.samples.length - LIVE_MAX_SAMPLES); }

    const rec = RecordingProps.ingest({ t0Unix: session.t0, model: session.facts.models[0]?.id ?? null, info: session.info, engines: session.engines, samples: session.samples });
    this.set({
      rec,
      t: this.state.follow ? rec.tEnd : Math.min(this.state.t, rec.tEnd),
      live: this.state.live && { ...this.state.live, scrapes: session.samples.length },
    });
  }
}

export const INSPECTOR = new InspectorStore();

export function useInspector(): InspectorState {
  return useSyncExternalStore(INSPECTOR.subscribe, INSPECTOR.getState);
}
