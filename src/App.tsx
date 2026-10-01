import { useEffect, useState } from 'react';

import ConnectDialog from './components/ConnectDialog';
import KpiStrip from './components/KpiStrip';
import Splash from './components/Splash';
import TopBar from './components/TopBar';
import { Card, ErrorCard } from './components/ui';
import { int } from './model/format';
import Deployment from './panels/Deployment';
import Latency from './panels/Latency';
import Scheduler from './panels/Scheduler';
import Timeline from './panels/Timeline';
import { INSPECTOR, useInspector } from './store/InspectorStore';

const STEP_S = 0.1;
const STEP_LONG_S = 1;

const App = () => {
  const state = useInspector();
  const [connecting, setConnecting] = useState(false);
  const { rec, live, server, t, windowS, range } = state;

  useEffect(() => { void INSPECTOR.init(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) { return; }
      if (e.code === 'Escape') {
        INSPECTOR.clearRange();
      } else if (e.code === 'Space') {
        e.preventDefault();
        INSPECTOR.setFollow(!INSPECTOR.state.follow);
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        INSPECTOR.step((e.shiftKey ? STEP_LONG_S : STEP_S) * (e.code === 'ArrowLeft' ? -1 : 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openDialog = () => setConnecting(true);
  const closeDialog = () => setConnecting(false);

  const dialog = connecting && <ConnectDialog onClose={closeDialog} />;

  if (!rec) {
    return <>{dialog}<Splash state={state} onConnect={openDialog} /></>;
  }

  const x1 = range ? range[1] : Math.max(rec.tEnd, 1e-3);
  const x0 = range ? range[0] : windowS != null ? Math.max(0, x1 - windowS) : 0;
  return (
    <>
      <TopBar state={state} />
      <KpiStrip rec={rec} t={t} />
      {live?.error && <ErrorCard message={live.error} />}
      <main>
        <Card title="Engine" count={`${int(rec.rows.length)} scrapes`}
          note="One column per scrape. Top: KV cache usage. Middle: tokens through the forward pass, prefill stacked on decode. Bottom: running requests with waiting ones stacked on top, red ticks for preemptions. Click to move the playhead; press and drag left or right to zoom to a range (Esc or × to go back). Hover for the values at that scrape.">
          <Timeline rec={rec} t={t} x0={x0} x1={x1} onScrub={(v) => INSPECTOR.seek(v)} onRange={(a, b) => INSPECTOR.setRange(a, b)} />
        </Card>
        <div className="row even">
          <Card title="Scheduler" note="Continuous batching as it ran: one dot per scrape, batch size against throughput. Total decode tok/s grows with the batch while each request's own tok/s falls; the dashed line is max_num_seqs (times the engine cores) when /server_info is served. Tokens per step are against max_num_batched_tokens, the per-step budget chunked prefill fills."><Scheduler rec={rec} server={server} t={t} x0={x0} /></Card>
          <Card title="Latency"><Latency rec={rec} t={t} x0={x0} x1={x1} /></Card>
        </div>
        <Card title="Deployment" count={server.version ? `vLLM ${server.version}` : undefined}
          note="Detected from the series the server exports; TP, PP and the scheduler limits come from /server_info, which only a server started with VLLM_SERVER_DEV_MODE=1 serves (dev endpoints, not for production).">
          <Deployment rec={rec} server={server} t={t} />
        </Card>
      </main>
    </>
  );
};

export default App;
