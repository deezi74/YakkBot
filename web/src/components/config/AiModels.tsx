import { useCallback, useEffect, useState } from 'react';
import type { EngineProvider } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { useConfigUI } from '../../configStore';

/**
 * Every way a bot can think, in one place: models on this device (GGUF, free and offline) and API
 * keys for cloud providers, plus the model all bots use unless one picks its own.
 */
export function AiModels() {
  const [providers, setProviders] = useState<EngineProvider[] | null>(null);
  const [def, setDef] = useState<{ provider: string | null; model: string | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    configApi.providers().then(setProviders).catch((e) => setError((e as Error).message));
    configApi.modelDefaults().then((d) => setDef({ provider: d.provider, model: d.model })).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const ready = (providers ?? []).filter((p) => p.connected);
  const current = providers?.find((p) => p.id === def?.provider);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); if (done) setNote(done); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const saveDefault = (provider: string | null, model: string | null, applyToAll = false) =>
    run(() => configApi.setModelDefaults({ provider, model, applyToAll }), applyToAll ? 'Every Bot now uses this model.' : 'Saved. New Bots and Bots without their own pick use it.');
  const openModels = () => useConfigUI.getState().openAppSettings('models');
  const status = (p: EngineProvider) => p.id === 'phone' ? (p.connected ? `${p.models.length} downloaded` : 'No model downloaded yet') : p.connected ? (p.fromEnv ? 'Key from the server settings' : 'Connected') : p.keyless ? 'Not set up' : 'Needs a key';

  return (
    <>
      <div className="app-settings__head">
        <h1>AI models</h1>
        <p>Choose what your Bots think with: a free model that runs on this device (GGUF, works offline), or a cloud AI with an API key. Keys stay on this device and are shared by all Bots. Each Bot can still pick its own in its menu.</p>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Default for all Bots</div>
        <div className="cfg-card">
          {!providers ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : ready.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing is set up yet. Download a model below, or add an API key.</div>
          ) : (
            <div className="cfg-row cfg-row--stack">
              <label className="ai-field">
                <span>Provider</span>
                <select className="text-input" value={def?.provider ?? ''} disabled={busy} onChange={(e) => saveDefault(e.target.value || null, null)}>
                  {ready.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {current && (
                <label className="ai-field">
                  <span>Model</span>
                  {current.models.length ? (
                    <select className="text-input" value={def?.model ?? ''} disabled={busy} onChange={(e) => saveDefault(current.id, e.target.value)}>
                      {!current.models.includes(def?.model ?? '') && def?.model && <option value={def.model}>{def.model}</option>}
                      {current.models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <input className="text-input" defaultValue={def?.model ?? ''} placeholder="Model name" onBlur={(e) => e.target.value.trim() && saveDefault(current.id, e.target.value.trim())} />
                  )}
                </label>
              )}
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || !current} onClick={() => current && saveDefault(current.id, def?.model ?? null, true)}>Use this for every Bot</button>
            </div>
          )}
        </div>
        {note && <div className="cfg-field__hint" role="status">{note}</div>}
        {error && <div className="cfg-error">{error}</div>}
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">On this device (free, offline)</div>
        <div className="cfg-card">
          {(providers ?? []).filter((p) => p.id === 'phone').map((p) => (
            <div key={p.id} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">GGUF models · llama.cpp</div>
                <div className="cfg-row__sub">{status(p)}. Pick from suggested models sized for this device, or search Hugging Face for any GGUF.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--primary" onClick={openModels}>{p.connected ? 'Manage' : 'Download'}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Cloud AI (API keys)</div>
        <div className="cfg-card">
          {(providers ?? []).filter((p) => p.id !== 'phone').map((p) => (
            <div key={p.id} className="cfg-row cfg-row--stack">
              <div className="ai-provider">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{p.name}</div>
                  <div className="cfg-row__sub">{status(p)}{p.connected && p.defaultModel ? ` · ${p.defaultModel}` : ''}</div>
                </div>
                {p.connected && !p.fromEnv ? (
                  <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => run(() => configApi.removeProvider(p.id), `${p.name} removed.`)}>Remove</button>
                ) : !p.connected ? (
                  <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setOpen(open === p.id ? null : p.id); setKey(''); setUrl(p.baseUrl ?? ''); }}>{open === p.id ? 'Cancel' : p.keyless ? 'Set up' : 'Add key'}</button>
                ) : null}
              </div>
              {open === p.id && (
                <form className="cfg-inline-form ai-form" onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => { await configApi.setProvider(p.id, { apiKey: key.trim() || undefined, baseUrl: p.needsBaseUrl ? url.trim() || undefined : undefined }); setOpen(null); }, `${p.name} connected.`);
                }}>
                  {p.needsBaseUrl && <input className="text-input" placeholder={p.id === 'ollama' ? 'http://127.0.0.1:11434' : 'https://…/v1'} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Address" />}
                  {!p.keyless || p.id === 'custom' ? <input className="text-input" type="password" autoComplete="off" placeholder={p.keyHint ?? 'API key'} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${p.name} API key`} /> : null}
                  <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || (!p.keyless && p.id !== 'custom' && !key.trim()) || (!!p.needsBaseUrl && !url.trim())}>Save</button>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
