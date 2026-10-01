import { useEffect, useRef, useState, type FormEvent } from 'react';

import { INSPECTOR } from '../store/InspectorStore';

const ConnectDialog = ({ onClose }: { onClose: () => void }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(INSPECTOR.defaultUrl);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (connecting) { return; }
    setConnecting(true);
    const failed = await INSPECTOR.connect(url);
    setConnecting(false);
    if (failed) {
      setError(failed);
      return;
    }
    onClose();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Connect" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); } }}>
      <form className="dialog" onSubmit={handleSubmit}>
        <h2>Connect to vLLM</h2>
        <input ref={inputRef} value={url} spellCheck={false} placeholder="http://localhost:8000" aria-label="vLLM server"
          onChange={(e) => setUrl(e.target.value)} />
        {error && <div className="error" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={connecting}>{connecting ? 'Connecting' : 'Connect'}</button>
        </div>
      </form>
    </div>
  );
};

export default ConnectDialog;
