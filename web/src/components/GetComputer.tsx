import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { useFeatures } from '../store';
import { Icon } from './Icon';

/**
 * Shown in the details panel while the bots have no screen. In the YakkBot app one tap installs a
 * desktop with a browser in the app's own Linux; after that the live screen takes this card's place.
 */
export function GetComputer({ bot }: { bot: Bot }) {
  const f = useFeatures();
  const [state, setState] = useState<string>('none');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!f.app) return;
    let alive = true;
    const load = () => fetch('/api/desktop', { credentials: 'include' }).then((r) => r.json()).then((d) => { if (alive && d?.state) setState(d.state); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [f.app]);

  // Installed: the server restarts with the screen switched on; reload to pick it up.
  useEffect(() => {
    if (state !== 'ready') return;
    const t = setTimeout(() => location.reload(), 8000);
    return () => clearTimeout(t);
  }, [state]);

  const install = async () => {
    setError(null);
    const r = await fetch('/api/desktop/install', { method: 'POST', credentials: 'include' }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    if (!r?.ok) setError(d?.error ?? 'Could not start the install.');
    else setState('installing: starting');
  };

  const installing = state.startsWith('installing');
  const failed = state.startsWith('failed');
  return (
    <div className="get-computer">
      <div className="get-computer__screen" aria-hidden>
        <Icon name="monitor" size={28} opacity={0.5} />
      </div>
      <div className="get-computer__text">
        <div className="get-computer__title">{installing ? 'Setting up the computer…' : state === 'ready' ? 'The computer is ready' : `Give ${bot.name} a computer`}</div>
        <div className="get-computer__sub">
          {!f.app
            ? <>A desktop with a browser your bots use while you watch. On a phone in Termux, run <code>yakkbot desktop setup</code>.</>
            : installing ? state.replace(/^installing:\s*/, '').replace(/^./, (c) => c.toUpperCase()) + '. You can keep chatting.'
            : state === 'ready' ? 'Starting it up…'
            : 'A desktop with a Chrome browser your bots use while you watch, and you can take over any time. About 600 MB.'}
        </div>
        {(failed || error) && <div className="card__error">{error ?? state.replace(/^failed:\s*/, '')}</div>}
      </div>
      {f.app && !installing && state !== 'ready' && (
        <button type="button" className="btn btn--sm btn--bot" onClick={install}>{failed ? 'Try again' : 'Install'}</button>
      )}
    </div>
  );
}
