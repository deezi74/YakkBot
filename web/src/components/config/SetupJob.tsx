import { useEffect, useState } from 'react';
import { configApi, type SetupJob } from '../../lib/configApi';

/** A button that runs one of the server's fixed setup jobs (Termux/Linux) and shows its progress. */
export function SetupJobButton({ job, label, onDone }: { job: 'engine' | 'desktop'; label: string; onDone?: () => void }) {
  const [s, setS] = useState<SetupJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { configApi.setupJob(job).then(setS).catch(() => {}); }, [job]);
  useEffect(() => {
    if (s?.state !== 'running') return;
    const t = setInterval(() => {
      configApi.setupJob(job).then((n) => { setS(n); if (n.state === 'done') onDone?.(); }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [s?.state, job, onDone]);
  if (!s) return null;
  if (!s.available) return <div className="cfg-field__hint">{s.why}</div>;
  const start = () => { setError(null); configApi.startSetupJob(job).then(setS).catch((e) => setError((e as Error).message)); };
  return (
    <div className="setup-job">
      <button type="button" className="cfg-btn cfg-btn--primary" disabled={s.state === 'running'} onClick={start}>
        {s.state === 'running' ? 'Installing… (this can take a few minutes)' : s.state === 'failed' ? `Try again: ${label}` : s.state === 'done' ? 'Installed ✓' : label}
      </button>
      {(s.state === 'running' || s.state === 'failed') && s.log && <pre className="setup-job__log">{s.log.split('\n').slice(-12).join('\n')}</pre>}
      {error && <div className="cfg-error">{error}</div>}
    </div>
  );
}
