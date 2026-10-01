import type { InspectorState } from '../store/InspectorStore';
import { BusyCard } from './ui';

const Splash = ({ state, onConnect }: { state: InspectorState; onConnect: () => void }) => (
  <div className="splash">
    <div className="welcome">
      {state.busy ? <BusyCard status={state.busy} detail="Waiting for the first /metrics scrape" /> : (<>
        <h1>vLLM inspector</h1>
        <p>Connect to a running vLLM server to watch its <code>/metrics</code></p>
        <div className="actions">
          <button type="button" className="primary" onClick={onConnect}>Connect</button>
        </div>
        {state.error && <div className="error" role="alert">{state.error}</div>}
      </>)}
    </div>
  </div>
);

export default Splash;
