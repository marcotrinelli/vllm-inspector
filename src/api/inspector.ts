/* The browser talks to vLLM directly, for `/metrics`. A server that needs credentials sits
 * behind a proxy that adds them; a browser cannot send them past an authenticating proxy,
 * which answers the CORS preflight itself. */

import { ServerProps, type ServerFacts } from '../model/server';

export class ApiError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

const TIMEOUT_MS = 8000;
const SUFFIXES = /\/(metrics|v1\/models|v1|health|version)\/?$/;

const isLocal = (host: string): boolean => /^(localhost|127\.|\[::1\]$)/.test(host);

/* given what the user typed, the server root: scheme defaulted, known endpoint paths
 * stripped. Error string on something the browser cannot fetch */
export function normalizeUrl(raw: string): { base: string; error: string } {
  const text = raw.trim();
  if (!text) { return { base: '', error: 'Enter the server address, e.g. http://localhost:8000' }; }
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { base: '', error: `'${text}' is not an address, e.g. http://localhost:8000` };
  }
  const base = `${u.origin}${u.pathname}`.replace(SUFFIXES, '').replace(/\/+$/, '');
  if (typeof location !== 'undefined' && location.protocol === 'https:' && u.protocol === 'http:' && !isLocal(u.hostname)) {
    return { base, error: `This page is served over https, so the browser blocks ${base}: serve the inspector over http, or the server over https` };
  }
  return { base, error: '' };
}

async function get(url: string, what: string): Promise<Response> {
  try {
    return await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    // a CORS refusal and a closed port look the same from a page: fetch only says it failed
    throw new ApiError(timedOut
      ? `${what} timed out`
      : `Cannot reach ${what}. Check the address; if something in front of it asks for credentials or blocks this page's origin, connect through a proxy that handles them`);
  }
}

export class VllmClient {
  constructor(public base: string) {}

  async metrics(): Promise<string> {
    const res = await get(`${this.base}/metrics`, this.base);
    if (res.ok) { return res.text(); }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(`${this.base} asks for credentials (HTTP ${res.status}), which a browser cannot add: connect through a proxy that adds them`, res.status);
    }
    if (res.status === 404) { throw new ApiError(`No /metrics at ${this.base}. Use the vLLM server root, e.g. http://localhost:8000`, 404); }
    throw new ApiError(`${this.base} answered HTTP ${res.status} for /metrics`, res.status);
  }

  /* everything but /metrics is optional: an endpoint that is missing or fails reads as unknown */
  async facts(): Promise<ServerFacts> {
    const [version, models, info] = await Promise.all([
      this.optional('/version'),
      this.optional('/v1/models'),
      // dev-mode only (VLLM_SERVER_DEV_MODE=1): 404 on a production server
      this.optional('/server_info?config_format=json'),
    ]);
    const v = (version as { version?: unknown } | null)?.version;
    return {
      version: typeof v === 'string' ? v : null,
      models: ServerProps.models(models),
      config: info ? ServerProps.config(info) : null,
    };
  }

  private async optional(path: string): Promise<unknown> {
    try {
      const res = await get(`${this.base}${path}`, this.base);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }
}
