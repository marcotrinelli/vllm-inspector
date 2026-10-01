import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import App from './App';
import { INSPECTOR } from './store/InspectorStore';

// jsdom rewrites import.meta.url, so fixtures are found from the project root
const fixture = (name: string) => readFileSync(join(process.cwd(), 'src/fixtures', name), 'utf8');
// a real scrape from vLLM 0.26
const SCRAPE = fixture('metrics.txt');

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// vLLM at :8000, and one behind an authenticating proxy
const routes: Record<string, () => Response> = {
  'localhost:8000/metrics': () => new Response(SCRAPE),
  'localhost:8000/v1/models': () => json({ data: [{ id: 'Qwen/Qwen3.6-35B-A3B', max_model_len: 8192 }] }),
  'localhost:8000/version': () => json({ version: '0.26.0' }),
  // a dev-mode server (VLLM_SERVER_DEV_MODE=1)
  'dev:8000/metrics': () => new Response(SCRAPE),
  'dev:8000/server_info': () => json({ vllm_config: { parallel_config: { tensor_parallel_size: 2, pipeline_parallel_size: 1, data_parallel_size: 1 }, scheduler_config: { max_num_seqs: 128 } } }),
  'locked:8000/metrics': () => new Response('', { status: 401 }),
};

beforeAll(() => {
  // jsdom has no canvas; the charts treat a missing context as "do not draw"
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    const route = routes[`${url.host}${url.pathname}`];
    // what a closed port or a CORS refusal looks like from a page
    if (!route) { throw new TypeError('Failed to fetch'); }
    return route();
  }));
});

afterEach(() => INSPECTOR.disconnect());

afterAll(() => vi.unstubAllGlobals());

const connectVia = async (url: string) => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]);
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('vLLM server'), { target: { value: url } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
  return dialog;
};

describe('App', () => {
  it('explains an unreachable server in the dialog instead of connecting', async () => {
    render(<App />);
    const dialog = await connectVia('nope:1');
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Cannot reach http:\/\/nope:1/);
  });

  it('points a server that asks for credentials to a proxy', async () => {
    render(<App />);
    const dialog = await connectVia('http://locked:8000');
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/asks for credentials \(HTTP 401\).*proxy/);
  });

  it('goes live on /metrics alone', async () => {
    render(<App />);
    await connectVia('localhost:8000');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Live' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Qwen/Qwen3.6-35B-A3B').length).toBeGreaterThan(0));
    const deployment = screen.getByRole('region', { name: 'Deployment' });
    expect(within(deployment).getByText('vLLM 0.26.0')).toBeTruthy();
    expect(within(deployment).getByText('8,953')).toBeTruthy();
    // no /server_info: the parallel layout is unknown, and the card says how to get it
    expect(within(deployment).getAllByText('needs /server_info (VLLM_SERVER_DEV_MODE=1)')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Latency' })).toBeTruthy();
  });

  it('reads the parallel layout of a dev-mode server', async () => {
    render(<App />);
    await connectVia('dev:8000');
    const deployment = await screen.findByRole('region', { name: 'Deployment' });
    await waitFor(() => expect(within(deployment).getByText('2 GPUs per engine core')).toBeTruthy());
    expect(within(deployment).getByText('128')).toBeTruthy();
  });

  it('stops and restarts polling', async () => {
    render(<App />);
    await connectVia('localhost:8000');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Pause polling' }));
    expect(screen.getByRole('status').getAttribute('title')).toBe('polling paused');
    const scrapes = INSPECTOR.state.live?.scrapes;
    await new Promise((r) => setTimeout(r, 1200));
    expect(INSPECTOR.state.live?.scrapes).toBe(scrapes);
    fireEvent.click(screen.getByRole('button', { name: 'Resume polling' }));
    await waitFor(() => expect(INSPECTOR.state.live?.scrapes).toBeGreaterThan(scrapes ?? 0));
    expect(screen.getByRole('button', { name: 'Pause polling' })).toBeTruthy();
  });

  it('zooms to a picked range until it is cleared', async () => {
    render(<App />);
    await connectVia('localhost:8000');
    await waitFor(() => expect(INSPECTOR.state.rec?.tEnd ?? 0).toBeGreaterThan(2), { timeout: 5000 });
    const end = INSPECTOR.state.rec?.tEnd ?? 0;
    INSPECTOR.setRange(end, 0);
    expect(INSPECTOR.state.range).toEqual([0, end]);
    // a picked range is history: the playhead sits on its end and stops following
    expect(INSPECTOR.state.follow).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear selection' }));
    expect(INSPECTOR.state.range).toBeNull();
    INSPECTOR.setRange(0, end);
    fireEvent.keyDown(window, { code: 'Escape' });
    expect(INSPECTOR.state.range).toBeNull();
    // narrower than two scrapes holds no rate
    INSPECTOR.setRange(0, 1);
    expect(INSPECTOR.state.range).toBeNull();
  }, 10000);

  it('returns to the connect screen on disconnect', async () => {
    render(<App />);
    await connectVia('localhost:8000');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Deployment' })).toBeNull();
  });
});
