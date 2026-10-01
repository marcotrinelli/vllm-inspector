/* What the server says about itself outside /metrics: `/version`, `/v1/models` and
 * `/server_info`, which only a server started with `VLLM_SERVER_DEV_MODE=1` answers. The
 * parallel layout (TP, PP, DP ranks) is only in `/server_info`; /metrics carries the DP
 * engine index and nothing else about it. */

export interface ModelCard {
  id: string;
  maxModelLen: number | null;
  // base model of a LoRA adapter, null for a base model
  parent: string | null;
}

/* `/server_info` flattened to what the panels read. Null fields are ones the text format
 * of an older server does not carry */
export interface EngineConfig {
  tp: number;
  pp: number;
  dp: number;
  dpLocal: number;
  dcp: number;
  ep: boolean;
  nnodes: number;
  executor: string | null;
  dtype: string | null;
  quantization: string | null;
  kvDtype: string | null;
  maxModelLen: number | null;
  maxNumSeqs: number | null;
  maxNumBatchedTokens: number | null;
  chunkedPrefill: boolean | null;
  asyncScheduling: boolean | null;
  policy: string | null;
  enforceEager: boolean | null;
  spec: { method: string; k: number } | null;
  maxLoras: number | null;
  kvRole: string | null;
  kvConnector: string | null;
  gpuNames: string[];
}

export interface ServerFacts {
  version: string | null;
  models: ModelCard[];
  config: EngineConfig | null;
}

export const NO_FACTS: ServerFacts = { version: null, models: [], config: null };

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
const str = (v: unknown): string | null => (v == null || v === '' || v === 'None' ? null : String(v));
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'True' ? true : v === 'False' ? false : null);
// torch dtypes serialize as `torch.bfloat16`
const dtype = (v: unknown): string | null => str(v)?.replace(/^torch\./, '') ?? null;

export class ServerProps {
  static models(body: unknown): ModelCard[] {
    const data = obj(body).data;
    if (!Array.isArray(data)) { return []; }
    return data.map((m) => obj(m)).filter((m) => typeof m.id === 'string').map((m) => ({
      id: m.id as string,
      maxModelLen: num(m.max_model_len),
      parent: str(m.parent),
    }));
  }

  /* `/server_info` in either format: `config_format=json` since vLLM 0.10, a `str(VllmConfig)`
   * before it. Null when the body is neither */
  static config(body: unknown): EngineConfig | null {
    const info = obj(body);
    const system = obj(info.system_env);
    const gpuNames = String(system.nvidia_gpu_models ?? '').split('\n')
      .map((l) => l.replace(/^GPU \d+:\s*/, '').trim()).filter(Boolean);
    const raw = info.vllm_config;
    if (typeof raw === 'string') { return { ...fromText(raw), gpuNames }; }
    if (raw && typeof raw === 'object') { return { ...fromJson(obj(raw)), gpuNames }; }
    return null;
  }
}

function fromJson(c: Json): Omit<EngineConfig, 'gpuNames'> {
  const p = obj(c.parallel_config);
  const s = obj(c.scheduler_config);
  const m = obj(c.model_config);
  const cache = obj(c.cache_config);
  const spec = c.speculative_config ? obj(c.speculative_config) : null;
  const lora = c.lora_config ? obj(c.lora_config) : null;
  const kv = c.kv_transfer_config ? obj(c.kv_transfer_config) : null;
  const dp = num(p.data_parallel_size) ?? 1;
  return {
    tp: num(p.tensor_parallel_size) ?? 1,
    pp: num(p.pipeline_parallel_size) ?? 1,
    dp,
    dpLocal: num(p.data_parallel_size_local) ?? dp,
    dcp: num(p.decode_context_parallel_size) ?? 1,
    ep: bool(p.enable_expert_parallel) ?? false,
    nnodes: num(p.nnodes) ?? 1,
    executor: str(p.distributed_executor_backend),
    dtype: dtype(m.dtype),
    quantization: str(m.quantization),
    kvDtype: str(cache.cache_dtype),
    maxModelLen: num(m.max_model_len),
    maxNumSeqs: num(s.max_num_seqs),
    maxNumBatchedTokens: num(s.max_num_batched_tokens),
    chunkedPrefill: bool(s.enable_chunked_prefill),
    asyncScheduling: bool(s.async_scheduling),
    policy: str(s.policy),
    enforceEager: bool(m.enforce_eager),
    spec: spec && str(spec.method) ? { method: String(spec.method), k: num(spec.num_speculative_tokens) ?? 0 } : null,
    maxLoras: lora ? num(lora.max_loras) : null,
    kvRole: kv ? str(kv.kv_role) : null,
    kvConnector: kv ? str(kv.kv_connector) : null,
  };
}

// `str(VllmConfig)` is `key=value, ` pairs; nested configs are reprs we do not read
function fromText(text: string): Omit<EngineConfig, 'gpuNames'> {
  const get = (key: string): string | null => str(new RegExp(`\\b${key}=([^,]+)`).exec(text)?.[1]?.trim());
  const dp = num(get('data_parallel_size')) ?? 1;
  return {
    tp: num(get('tensor_parallel_size')) ?? 1,
    pp: num(get('pipeline_parallel_size')) ?? 1,
    dp,
    dpLocal: dp,
    dcp: num(get('decode_context_parallel_size')) ?? 1,
    ep: false,
    nnodes: 1,
    executor: null,
    dtype: dtype(get('dtype')),
    quantization: get('quantization'),
    kvDtype: get('kv_cache_dtype'),
    maxModelLen: num(get('max_seq_len')),
    maxNumSeqs: null,
    maxNumBatchedTokens: null,
    chunkedPrefill: bool(get('enable_chunked_prefill')),
    asyncScheduling: null,
    policy: null,
    enforceEager: bool(get('enforce_eager')),
    spec: null,
    maxLoras: null,
    kvRole: null,
    kvConnector: null,
  };
}
