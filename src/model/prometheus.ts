/* One `/metrics` scrape. Metric names lose the `vllm:` prefix; every non-identity label
 * becomes a split of the metric as well as folding into its total. */
export interface Scrape {
  m: Record<string, number>;
  h: Record<string, Record<string, number>>;
  l: Record<string, Record<string, number>>;
  info: Record<string, Record<string, string>>;
  // `engine` label values: one per data-parallel engine core
  engines: string[];
  // per engine core, the same totals as `m`
  e: Record<string, Record<string, number>>;
}

// These identify the server, not a slice of the metric; splitting on them would turn
// every counter into a one-entry map
const IDENTITY_LABELS = new Set(['model_name', 'engine', 'engine_index', 'instance', 'job']);
const RE_SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+([^ \t]+)/;
const RE_LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parseScrape(text: string): Scrape {
  const m: Scrape['m'] = {};
  const h: Scrape['h'] = {};
  const l: Scrape['l'] = {};
  const info: Scrape['info'] = {};
  const e: Scrape['e'] = {};

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') { continue; }
    const hit = RE_SAMPLE.exec(line);
    if (!hit) { continue; }
    const labels: Record<string, string> = {};
    RE_LABEL.lastIndex = 0;
    let lm = RE_LABEL.exec(hit[2] ?? '');
    while (lm) {
      labels[lm[1]] = lm[2];
      lm = RE_LABEL.exec(hit[2] ?? '');
    }
    const short = hit[1].startsWith('vllm:') ? hit[1].slice(5) : hit[1];
    // the value of an _info series is a constant 1, the labels are the payload
    if (short.endsWith('_info')) {
      info[short] = labels;
      continue;
    }
    // unix timestamp of a counter's creation, not data
    if (short.endsWith('_created')) { continue; }
    const v = parseFloat(hit[3]);
    if (!Number.isFinite(v)) { continue; }
    if (short.endsWith('_bucket') && labels.le != null) {
      const base = short.slice(0, -7);
      const b = h[base] ?? (h[base] = {});
      b[labels.le] = (b[labels.le] ?? 0) + v;
      continue;
    }
    m[short] = (m[short] ?? 0) + v;
    if (labels.engine != null) {
      const per = e[labels.engine] ?? (e[labels.engine] = {});
      per[short] = (per[short] ?? 0) + v;
    }
    const keys = Object.keys(labels).filter((k) => !IDENTITY_LABELS.has(k)).sort();
    if (keys.length) {
      const key = keys.map((k) => `${k}=${labels[k]}`).join(',');
      const split = l[short] ?? (l[short] = {});
      split[key] = (split[key] ?? 0) + v;
    }
  }
  // a fraction summed over data-parallel engines reads past 100%: the pool-wide figure is the mean
  const engines = Object.keys(e).sort((a, b) => +a - +b || a.localeCompare(b));
  if (engines.length > 1) {
    for (const k of Object.keys(m)) {
      if (k.endsWith('_perc')) { m[k] /= engines.length; }
    }
  }
  return { m, h, l, info, engines, e };
}
