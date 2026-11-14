import { useCallback, useEffect, useState } from 'react';
import { speak } from '../../voice/talk';
import { SetupJobButton } from './SetupJob';

interface Engine { id: string; name: string; ready: boolean; note: string; voices?: { id: string; name: string }[]; installed?: boolean }
interface Options {
  tts: Engine[]; stt: Engine[]; realtime: boolean;
  settings: { tts: string; ttsVoice: string; stt: string; voiceMode: 'talk' | 'realtime'; ttsUrl: string };
  services: { voice: { installed: boolean; running: boolean } };
}

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`/api/speech${path}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? j.message ?? `HTTP ${r.status}`);
  return j;
};

/** Settings › Voice: how bots talk (several voices, including the free one D-Agent uses) and how they hear you. */
export function VoicePage() {
  const [o, setO] = useState<Options | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call('GET', '/options').then((j: Options) => { setO(j); setUrl(j.settings.ttsUrl); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const save = async (patch: Record<string, unknown>) => {
    setError(null); setNote(null);
    try { setO(await call('PUT', '/settings', patch)); } catch (e) { setError((e as Error).message); }
  };
  const preview = async () => {
    if (!o) return;
    setBusy('preview'); setError(null);
    try { await speak({ tts: o.settings.tts, ttsVoice: o.settings.ttsVoice }, 'Hi! This is how I will sound when we talk.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const startFree = async () => {
    setBusy('start'); setError(null);
    try { const r = await call('POST', '/services/voice/start'); setNote(r.message); load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  if (!o) return <div className="app-settings__head"><h1>Voice</h1><p>{error ?? 'Loading…'}</p></div>;
  const tts = o.tts.find((e) => e.id === o.settings.tts);

  return (
    <>
      <div className="app-settings__head">
        <h1>Voice</h1>
        <p>Tap the voice button in any chat to talk with a Bot hands-free. It works with every model, including free and on-device ones. Pick how Bots sound and how they hear you.</p>
      </div>

      {o.realtime && (
        <section className="cfg-section">
          <div className="cfg-section__label">Voice button</div>
          <div className="cfg-card" role="radiogroup">
            {([['talk', 'Talk mode', 'Uses each Bot’s own model and the voice below.'], ['realtime', 'Grok realtime call', 'A live phone-call feel with Grok’s voice agent (uses your Grok key).']] as const).map(([id, title, sub]) => (
              <label key={id} className="cfg-row cfg-row--choice">
                <input type="radio" name="voice-mode" checked={o.settings.voiceMode === id} onChange={() => save({ voiceMode: id })} />
                <div className="cfg-row__text"><div className="cfg-row__title">{title}</div><div className="cfg-row__sub">{sub}</div></div>
              </label>
            ))}
          </div>
        </section>
      )}

      <section className="cfg-section">
        <div className="cfg-section__label">How Bots sound</div>
        <div className="cfg-card" role="radiogroup">
          {o.tts.map((e) => (
            <label key={e.id} className={`cfg-row cfg-row--choice${!e.ready && e.id !== 'free' && e.id !== 'custom' ? ' is-disabled' : ''}`}>
              <input type="radio" name="tts" checked={o.settings.tts === e.id} disabled={!e.ready && e.id !== 'free' && e.id !== 'custom'} onChange={() => save({ tts: e.id })} />
              <div className="cfg-row__text"><div className="cfg-row__title">{e.name}{e.ready ? '' : ' · not ready'}</div><div className="cfg-row__sub">{e.note}</div></div>
            </label>
          ))}
        </div>

        {o.settings.tts === 'free' && (
          <div className="voice-free">
            {!o.services.voice.installed ? (
              <SetupJobButton job="voice" label="Set up the free voice" onDone={() => setTimeout(load, 3000)} />
            ) : !o.services.voice.running ? (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy} onClick={startFree}>{busy === 'start' ? 'Starting…' : 'Start the free voice'}</button>
            ) : <div className="cfg-field__hint">The free voice is running. If D-Agent’s voice is already running in Termux, YakkBot uses that one.</div>}
          </div>
        )}
        {o.settings.tts === 'custom' && (
          <form className="cfg-inline-form voice-free" onSubmit={(e) => { e.preventDefault(); save({ ttsUrl: url }); }}>
            <input className="text-input" placeholder="http://127.0.0.1:8880/v1" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Voice server address" />
            <button type="submit" className="cfg-btn cfg-btn--primary">Save</button>
          </form>
        )}

        {tts && (tts.voices?.length || o.settings.tts === 'custom') ? (
          <div className="voice-pick">
            {tts.voices?.length ? (
              <select className="text-input" value={o.settings.ttsVoice} onChange={(e) => save({ ttsVoice: e.target.value })} aria-label="Voice">
                {tts.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            ) : (
              <input className="text-input" defaultValue={o.settings.ttsVoice} placeholder="Voice name, e.g. af_heart" onBlur={(e) => save({ ttsVoice: e.target.value.trim() })} aria-label="Voice" />
            )}
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={preview}>{busy === 'preview' ? 'Playing…' : 'Preview'}</button>
          </div>
        ) : o.settings.tts === 'device' ? (
          <div className="voice-pick"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={preview}>{busy === 'preview' ? 'Playing…' : 'Preview'}</button></div>
        ) : null}
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">How Bots hear you</div>
        <div className="cfg-card" role="radiogroup">
          {o.stt.map((e) => (
            <label key={e.id} className={`cfg-row cfg-row--choice${!e.ready ? ' is-disabled' : ''}`}>
              <input type="radio" name="stt" checked={o.settings.stt === e.id} disabled={!e.ready} onChange={() => save({ stt: e.id })} />
              <div className="cfg-row__text"><div className="cfg-row__title">{e.name}</div><div className="cfg-row__sub">{e.note}</div></div>
            </label>
          ))}
        </div>
      </section>
      {note && <div className="cfg-field__hint" role="status">{note}</div>}
      {error && <div className="cfg-error">{error}</div>}
    </>
  );
}
