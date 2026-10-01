// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseScrape } from './prometheus';
import { RecordingProps, type RawSample } from './recording';
import { ServerProps } from './server';

// a real scrape from vLLM 0.26 (one request served, 8953 blocks of 1056 tokens)
const SCRAPE = parseScrape(readFileSync(new URL('../fixtures/metrics.txt', import.meta.url), 'utf8'));
const T0 = 1_800_000_000;

const sample = (t: number, bump: Record<string, number> = {}): RawSample => {
  const m = { ...SCRAPE.m };
  for (const [k, v] of Object.entries(bump)) { m[k] = (m[k] ?? 0) + v; }
  return { t, m, h: SCRAPE.h, l: SCRAPE.l, e: SCRAPE.e };
};

describe('prometheus', () => {
  it('parses a live vLLM 0.26 scrape', () => {
    expect(SCRAPE.info.cache_config_info.block_size).toBe('1056');
    expect(SCRAPE.m.num_requests_running).toBe(0);
    expect(Object.keys(SCRAPE.h)).toContain('time_to_first_token_seconds');
    expect(SCRAPE.h.time_to_first_token_seconds['+Inf']).toBeGreaterThanOrEqual(0);
    expect(SCRAPE.l.num_requests_waiting_by_reason).toEqual({ 'reason=capacity': 0, 'reason=deferred': 0 });
    expect(Object.keys(SCRAPE.m).some((k) => k.endsWith('_created'))).toBe(false);
    expect(SCRAPE.engines).toEqual(['0']);
  });

  it('keeps each data-parallel engine core and averages fractions across them', () => {
    const dp = parseScrape([
      'vllm:num_requests_running{engine="0",model_name="m"} 3',
      'vllm:num_requests_running{engine="1",model_name="m"} 5',
      'vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.2',
      'vllm:kv_cache_usage_perc{engine="1",model_name="m"} 0.4',
    ].join('\n'));
    expect(dp.engines).toEqual(['0', '1']);
    expect(dp.m.num_requests_running).toBe(8);
    expect(dp.m.kv_cache_usage_perc).toBeCloseTo(0.3);
    expect(dp.e['1']).toEqual({ num_requests_running: 5, kv_cache_usage_perc: 0.4 });
  });
});

describe('recording', () => {
  const rec = RecordingProps.ingest({
    t0Unix: T0,
    model: null,
    info: SCRAPE.info,
    engines: SCRAPE.engines,
    samples: [sample(5), sample(7, { generation_tokens_total: 100, iteration_tokens_total_sum: 300, num_preemptions_total: 1 })],
  });

  it('ingests scrapes relative to the first one', () => {
    expect(rec.rows).toHaveLength(2);
    expect(rec.rows[0].t).toBe(0);
    expect(rec.tEnd).toBe(2);
    expect(rec.t0Unix).toBe(T0 + 5);
    expect(rec.nBlocks).toBe(8953);
    expect(rec.blockSize).toBe(1056);
    expect(rec.apc).toBe(true);
    expect(rec.engines).toEqual(['0']);
  });

  it('rates a counter over a window, pool-wide and per engine core', () => {
    expect(RecordingProps.windowAt(rec, 2, 15)).toEqual([0, 1]);
    expect(RecordingProps.rate(rec, 'generation_tokens_total', 0, 1)).toBe(50);
    // the bump went into the pool-wide totals only
    expect(RecordingProps.rate(rec, 'generation_tokens_total', 0, 1, '0')).toBe(0);
    expect(RecordingProps.rate(rec, 'generation_tokens_total', 1, 1)).toBeNull();
  });

  it('derives rates from counter deltas', () => {
    const last = rec.rows[1];
    expect(last.decodePerS).toBe(50);
    // every forward-pass token that was not generated was prefill
    expect(last.prefillPerS).toBe(100);
    expect(last.cPreempt).toBe(1);
  });

  it('does not rate across a pause', () => {
    const paused = RecordingProps.ingest({
      t0Unix: T0,
      model: null,
      info: {},
      engines: [],
      samples: [sample(0), sample(1, { generation_tokens_total: 10 }), sample(61, { generation_tokens_total: 600 }), sample(62, { generation_tokens_total: 610 })],
    });
    expect(paused.rows[2].decodePerS).toBe(0);
    expect(paused.rows[3].decodePerS).toBe(10);
    // the window starts at the first scrape after the pause, not before it
    expect(RecordingProps.windowAt(paused, 62, 120)).toEqual([2, 3]);
  });

  it('reads histograms as windows and quantiles', () => {
    const w = RecordingProps.histWindow(rec, 'time_to_first_token_seconds', 0, 0);
    expect(w?.n).toBe(SCRAPE.h.time_to_first_token_seconds['+Inf']);
    expect(RecordingProps.quantile(w, 0.5)).toBeGreaterThan(0);
    // unchanged buckets between the two scrapes: nothing observed in that window
    expect(RecordingProps.histWindow(rec, 'time_to_first_token_seconds', 0, 1)?.n).toBe(0);
  });

  it('collects bucket edges from every sample, not only the first', () => {
    const late = RecordingProps.ingest({
      t0Unix: T0,
      model: null,
      info: {},
      engines: [],
      samples: [{ ...sample(0), h: {} }, sample(1)],
    });
    expect(late.edges.time_to_first_token_seconds.length).toBe(Object.keys(SCRAPE.h.time_to_first_token_seconds).length);
    expect(late.rows[0].h.time_to_first_token_seconds).toBeUndefined();
  });
});

// trimmed from `/server_info?config_format=json` on a dev-mode server
const SERVER_INFO = {
  vllm_config: {
    model_config: { dtype: 'torch.bfloat16', quantization: 'fp8', max_model_len: 32768, enforce_eager: false },
    cache_config: { cache_dtype: 'auto' },
    parallel_config: { tensor_parallel_size: 2, pipeline_parallel_size: 1, data_parallel_size: 1, data_parallel_size_local: 1, enable_expert_parallel: false },
    scheduler_config: { max_num_seqs: 256, max_num_batched_tokens: 8192, enable_chunked_prefill: true, policy: 'fcfs' },
    speculative_config: null,
    kv_transfer_config: { kv_connector: 'NixlConnector', kv_role: 'kv_producer' },
  },
  system_env: {
    nvidia_gpu_models: 'GPU 0: NVIDIA H100 80GB HBM3\nGPU 1: NVIDIA H100 80GB HBM3',
  },
};

describe('server', () => {
  it('reads the parallel layout and scheduler limits from /server_info json', () => {
    const c = ServerProps.config(SERVER_INFO);
    expect(c).toMatchObject({ tp: 2, pp: 1, dp: 1, dtype: 'bfloat16', quantization: 'fp8', maxNumSeqs: 256, maxNumBatchedTokens: 8192, kvRole: 'kv_producer', spec: null });
    expect(c?.gpuNames).toEqual(['NVIDIA H100 80GB HBM3', 'NVIDIA H100 80GB HBM3']);
  });

  it('falls back to the text format of an older server', () => {
    const c = ServerProps.config({ vllm_config: "model='m', dtype=torch.float16, max_seq_len=4096, tensor_parallel_size=4, pipeline_parallel_size=2, data_parallel_size=1, quantization=None, enforce_eager=True, kv_cache_dtype=fp8" });
    expect(c).toMatchObject({ tp: 4, pp: 2, dtype: 'float16', maxModelLen: 4096, quantization: null, enforceEager: true, kvDtype: 'fp8', maxNumSeqs: null });
  });

  it('reads a model card and ignores what is not one', () => {
    expect(ServerProps.models({ data: [{ id: 'a', max_model_len: 8192, parent: null }, { id: 'lora', parent: 'a' }, {}] })).toEqual([
      { id: 'a', maxModelLen: 8192, parent: null },
      { id: 'lora', maxModelLen: null, parent: 'a' },
    ]);
    expect(ServerProps.config({ detail: 'Not Found' })).toBeNull();
  });
});
