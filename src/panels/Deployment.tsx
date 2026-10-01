import { fmt, int, pct, si } from '../model/format';
import { Info } from '../components/ui';
import { RecordingProps, type Recording } from '../model/recording';
import type { ServerFacts } from '../model/server';

// per-engine rates over this much history, as in the KPI strip
const WINDOW_S = 15;
const NEEDS_INFO = 'needs /server_info (VLLM_SERVER_DEV_MODE=1)';

type State = 'on' | 'off' | 'unknown';

interface Feature {
  label: string;
  state: State;
  detail: string;
}

const isSet = (v: string | undefined): v is string => v != null && v !== '' && v !== 'None';

/* What the deployment is, from the series the server exports and, when served, its config */
function features(rec: Recording, server: ServerFacts): Feature[] {
  const cfg = server.config;
  const c = rec.cache;
  const last = rec.rows[rec.rows.length - 1];
  const cores = Math.max(1, rec.engines.length);
  const drafts = last.m.spec_decode_num_draft_tokens_total ?? 0;
  const accepted = last.m.spec_decode_num_accepted_tokens_total ?? 0;
  const external = last.l.prompt_tokens_by_source_total?.['source=external_kv_transfer'] ?? 0;
  const lora = rec.info.lora_requests_info;
  const mm = last.m.mm_cache_queries_total ?? 0;
  const parallel = (size: number | undefined): State => (size == null ? 'unknown' : size > 1 ? 'on' : 'off');
  return [
    { label: 'Tensor parallel', state: parallel(cfg?.tp), detail: cfg ? `${cfg.tp} GPU${cfg.tp > 1 ? 's' : ''} per engine core` : NEEDS_INFO },
    { label: 'Pipeline parallel', state: parallel(cfg?.pp), detail: cfg ? `${cfg.pp} stage${cfg.pp > 1 ? 's' : ''}` : NEEDS_INFO },
    { label: 'Data parallel', state: cores > 1 ? 'on' : 'off', detail: `${cores} engine core${cores > 1 ? 's' : ''}` },
    { label: 'Prefix caching', state: rec.apc ? 'on' : 'off', detail: rec.apc ? `${c.prefix_caching_hash_algo ?? '—'} hashing, block ${rec.blockSize}` : 'disabled in the cache config' },
    {
      label: 'Speculative decoding',
      state: cfg?.spec || rec.have.has('spec_decode_num_drafts_total') ? 'on' : 'off',
      detail: cfg?.spec ? `${cfg.spec.method}, ${cfg.spec.k} tokens${drafts ? `, ${pct(accepted / drafts, 0)} accepted` : ''}`
        : drafts ? `${pct(accepted / drafts, 0)} of draft tokens accepted` : 'no draft series exported',
    },
    {
      label: 'KV connector / disagg',
      state: cfg?.kvConnector || external > 0 ? 'on' : 'off',
      detail: cfg?.kvConnector ? `${cfg.kvConnector}, ${cfg.kvRole ?? 'no role'}` : external > 0 ? `${si(external)} prompt tokens pulled` : 'no external KV transfer',
    },
    { label: 'KV offloading', state: isSet(c.kv_offloading_size) ? 'on' : 'off', detail: isSet(c.kv_offloading_size) ? `${c.kv_offloading_backend}, ${c.kv_offloading_size} GiB` : 'KV lives on GPU only' },
    { label: 'LoRA adapters', state: lora ? 'on' : 'off', detail: lora ? `${lora.running_lora_adapters || 'none'} running, max ${lora.max_lora ?? '—'}` : 'no adapter series exported' },
    { label: 'Multimodal', state: mm > 0 ? 'on' : 'off', detail: mm > 0 ? `${si(mm)} cache queries` : 'no multimodal cache queries' },
  ];
}

const EngineRows = ({ rec, t }: { rec: Recording; t: number }) => {
  const [i0, i1] = RecordingProps.windowAt(rec, t, WINDOW_S);
  const row = rec.rows[i1];
  const first = rec.rows[0];
  const engines = rec.engines.length ? rec.engines : ['0'];
  return (
    <div className="scroll">
      <table className="rows">
        <thead>
          <tr>
            <th>engine</th>
            <td>running</td>
            <td>waiting</td>
            <td>KV</td>
            <td>gen tok/s</td>
            <td>prefix hits</td>
            <td>preempted</td>
          </tr>
        </thead>
        <tbody>
          {engines.map((e) => {
            // a single core may export no engine label at all: the pool-wide values are its own
            const at = (name: string) => (rec.engines.length ? row.e[e]?.[name] : row.m[name]) ?? 0;
            const rate = (name: string) => RecordingProps.rate(rec, name, i0, i1, rec.engines.length ? e : undefined);
            const queries = rate('prefix_cache_queries_total');
            const since = at('num_preemptions_total') - ((rec.engines.length ? first.e[e]?.num_preemptions_total : first.m.num_preemptions_total) ?? 0);
            return (
              <tr key={e}>
                <th>{e}</th>
                <td>{int(at('num_requests_running'))}</td>
                <td>{int(at('num_requests_waiting'))}</td>
                <td>{pct(at('kv_cache_usage_perc'), 0)}</td>
                <td>{fmt(rate('generation_tokens_total'), 0)}</td>
                <td>{queries ? pct((rate('prefix_cache_hits_total') ?? 0) / queries, 0) : '—'}</td>
                <td className={since > 0 ? 'tone-bad' : undefined}>{int(since)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

interface Props {
  rec: Recording;
  server: ServerFacts;
  t: number;
}

const Deployment = ({ rec, server, t }: Props) => {
  const cfg = server.config;
  const c = rec.cache;
  const model = server.models.find((m) => !m.parent);
  const onOff = (v: boolean | null | undefined) => (v == null ? undefined : v ? 'on' : 'off');
  const gpus = cfg?.gpuNames.length ? `${cfg.gpuNames.length} × ${cfg.gpuNames[0].replace(/^NVIDIA\s+/, '')}` : undefined;
  const config: Array<[string, string | undefined]> = [
    ['model', model?.id ?? rec.model ?? undefined],
    ['max_model_len', model?.maxModelLen == null ? undefined : int(model.maxModelLen)],
    ['GPUs', gpus],
    ['weights dtype', cfg?.dtype ?? undefined],
    ['quantization', cfg ? cfg.quantization ?? 'none' : undefined],
    ['KV dtype', c.cache_dtype],
    ['block size', isSet(c.block_size) ? `${c.block_size} tokens` : undefined],
    ['GPU blocks', isSet(c.num_gpu_blocks) ? `${int(+c.num_gpu_blocks)}${rec.engines.length > 1 ? ' per core' : ''}` : undefined],
    ['KV tokens', isSet(c.kv_cache_size_tokens) ? si(+c.kv_cache_size_tokens) : undefined],
    ['max concurrency', isSet(c.kv_cache_max_concurrency) ? `${fmt(+c.kv_cache_max_concurrency, 1)} × max_model_len` : undefined],
    ['GPU memory fraction', isSet(c.gpu_memory_utilization) ? c.gpu_memory_utilization : undefined],
    ['max_num_seqs', cfg?.maxNumSeqs == null ? undefined : `${int(cfg.maxNumSeqs)}${rec.engines.length > 1 ? ' per core' : ''}`],
    ['max_num_batched_tokens', cfg?.maxNumBatchedTokens == null ? undefined : `${int(cfg.maxNumBatchedTokens)}${rec.engines.length > 1 ? ' per core' : ''}`],
    ['chunked prefill', onOff(cfg?.chunkedPrefill)],
    ['async scheduling', onOff(cfg?.asyncScheduling)],
    ['CUDA graphs', cfg?.enforceEager == null ? undefined : cfg.enforceEager ? 'off (eager)' : 'on'],
  ];

  return (
    <>
      <div className="features">
        {features(rec, server).map((f) => (
          <div key={f.label} className="feature" data-state={f.state}>
            <strong>{f.label}</strong>
            <span>{f.detail}</span>
          </div>
        ))}
      </div>
      <div className="deploy-grid">
        <div>
          <h3 className="sub">Engine cores<Info text={`One row per data-parallel rank (the engine label in /metrics); tensor and pipeline parallel ranks live inside a core and do not appear separately. Rates over the last ${WINDOW_S} s, preemptions since connect.`} /></h3>
          <EngineRows rec={rec} t={t} />
        </div>
        <div>
          <h3 className="sub">Config<Info text="Cache settings from cache_config_info in /metrics, model length from /v1/models; weights dtype, quantization, GPUs and the scheduler limits only when /server_info is served. Block and token counts are per engine core." /></h3>
          <div className="config">
            {config.filter(([, v]) => v != null).map(([k, v]) => <div key={k}><span>{k}</span><b title={v}>{v}</b></div>)}
          </div>
        </div>
      </div>
    </>
  );
};

export default Deployment;
