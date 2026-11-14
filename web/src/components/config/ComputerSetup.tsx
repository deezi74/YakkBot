import { useCallback, useEffect, useState } from 'react';
import { configApi, type ComputerSetup, type OrgoWorkspace } from '../../lib/configApi';
import { SetupJobButton } from './SetupJob';

type Mode = ComputerSetup['mode'];

/**
 * Where the Bots' screens live, chosen right in the app: this device's own desktop, one shared
 * Orgo cloud computer (one screen per Bot, up to the limit), or no computer at all.
 */
export function ComputerSetupCard() {
  const [setup, setSetup] = useState<ComputerSetup | null>(null);
  const [key, setKey] = useState('');
  const [workspaces, setWorkspaces] = useState<OrgoWorkspace[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerSetup().then(setSetup).catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>, reload = false) => {
    setBusy(label); setError(null);
    try {
      await fn();
      // The feature flags and the computer card come from the server at start, so pick up the new setup.
      if (reload) window.location.reload();
      else load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const checkKey = (k?: string) => run('key', async () => {
    const r = await configApi.orgoKey(k);
    setWorkspaces(r.workspaces);
    setKey('');
  });

  if (!setup) return <section className="cfg-section"><div className="cfg-card"><div className="cfg-empty cfg-empty--flat">{error ?? 'Loading…'}</div></div></section>;

  const pick = (m: Mode) => {
    if (m === setup.mode) return;
    if (m === 'orgo' && !setup.orgo.computerId) { if (setup.orgo.hasKey) checkKey(); return; }
    run(`mode-${m}`, () => configApi.computerMode(m), true);
  };
  const options: { id: Mode; title: string; sub: string; disabled?: boolean }[] = [
    {
      id: 'local', title: 'This device',
      sub: setup.local.available ? 'A Linux desktop running right here. Free, works offline, one screen shared by your Bots.'
        : setup.local.app ? 'Install the desktop under Settings › Phone control first.' : 'Not set up yet. Use the button below.',
      disabled: !setup.local.available,
    },
    { id: 'orgo', title: 'Orgo cloud computer', sub: `One cloud computer with its own screen for each Bot, up to ${setup.mode === 'orgo' ? setup.maxBots : 4} Bots. Needs an Orgo API key.` },
    { id: 'none', title: 'No computer', sub: 'Bots chat, search and use your phone, but have no screen.' },
  ];

  return (
    <>
      <section className="cfg-section">
        <div className="cfg-section__label">Where Bots work</div>
        <div className="cfg-card" role="radiogroup" aria-label="Where Bots work">
          {options.map((o) => (
            <label key={o.id} className={`cfg-row cfg-row--choice${o.disabled ? ' is-disabled' : ''}`}>
              <input type="radio" name="computer-mode" checked={setup.mode === o.id} disabled={o.disabled || !!busy} onChange={() => pick(o.id)} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{o.title}{setup.mode === o.id ? ' · in use' : ''}</div>
                <div className="cfg-row__sub">{o.sub}</div>
              </div>
            </label>
          ))}
        </div>
        {!setup.local.available && !setup.local.app && (
          <SetupJobButton job="desktop" label="Set up a desktop on this device" onDone={() => setTimeout(() => window.location.reload(), 6000)} />
        )}
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Orgo computer</div>
        <div className="cfg-card">
          {setup.orgo.computerId && (
            <div className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{setup.orgo.computerName || 'Orgo computer'}</div>
                <div className="cfg-row__sub">Each Bot gets its own screen on it: the first on the main screen, then one new screen per Bot.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => checkKey()}>Change</button>
            </div>
          )}
          {!setup.orgo.hasKey ? (
            <div className="cfg-row cfg-row--stack">
              <div className="cfg-row__text">
                <div className="cfg-row__title">Orgo API key</div>
                <div className="cfg-row__sub">Sign in at orgo.ai, then open Settings › API keys and create one. It stays on this device.</div>
              </div>
              <form className="cfg-inline-form" onSubmit={(e) => { e.preventDefault(); if (key.trim()) checkKey(key.trim()); }}>
                <input className="text-input" type="password" autoComplete="off" placeholder="sk_live_…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Orgo API key" />
                <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!key.trim() || !!busy}>{busy === 'key' ? 'Checking…' : 'Connect'}</button>
              </form>
            </div>
          ) : !setup.orgo.computerId && !workspaces ? (
            <div className="cfg-row">
              <div className="cfg-row__text"><div className="cfg-row__title">Key saved</div><div className="cfg-row__sub">Pick the computer your Bots should use.</div></div>
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={() => checkKey()}>{busy === 'key' ? 'Loading…' : 'Choose computer'}</button>
            </div>
          ) : null}

          {workspaces && workspaces.map((w) => (
            <div key={w.id} className="cfg-row cfg-row--stack">
              <div className="cfg-row__text"><div className="cfg-row__title">{w.name}</div></div>
              {w.computers.length === 0 && <div className="cfg-row__sub">No Linux computers in this workspace yet.</div>}
              {w.computers.map((c) => (
                <div key={c.id} className="cfg-row cfg-row--nested">
                  <div className="cfg-row__text">
                    <div className="cfg-row__title">{c.name}</div>
                    <div className="cfg-row__sub">{c.status || 'Linux'}{c.id === setup.orgo.computerId ? ' · in use' : ''}</div>
                  </div>
                  <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy || c.id === setup.orgo.computerId} onClick={() => run(`use-${c.id}`, () => configApi.orgoUse(c.id, c.name), true)}>
                    {busy === `use-${c.id}` ? 'Switching…' : 'Use'}
                  </button>
                </div>
              ))}
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={() => run(`new-${w.id}`, () => configApi.orgoCreate(w.id), true)}>
                {busy === `new-${w.id}` ? 'Creating (about a minute)…' : 'Create a new YakkBot computer (4 cores, 16 GB)'}
              </button>
            </div>
          ))}

          {setup.orgo.hasKey && (
            <div className="cfg-row">
              <div className="cfg-row__text"><div className="cfg-row__sub">Remove the key and stop using Orgo on this device.</div></div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => run('forget', () => configApi.orgoForget(), true)}>Forget key</button>
            </div>
          )}
        </div>
        {error && <div className="cfg-error">{error}</div>}
        <div className="cfg-field__hint">Up to {setup.mode === 'orgo' ? setup.maxBots : 4} Bots can hold a screen on the Orgo computer at once.</div>
      </section>
    </>
  );
}
