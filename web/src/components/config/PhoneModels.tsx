import { useCallback, useEffect, useState } from 'react';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';

interface CatalogModel { id: string; name: string; maker: string; file: string; bytes: number; minRamGb: number; tag: string; note: string; fits: boolean }
interface Download { file: string; done: number; total: number; failed: boolean }
interface Status {
  engine: boolean; ramGb: number; recommended: string; state: string; running: string; error?: string;
  catalog: CatalogModel[]; installed: { file: string; bytes: number }[]; downloads: Download[];
}
interface HfFile { repo: string; path: string; file: string; bytes: number; url: string }

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/phone-models${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
  return d as T;
}

/** Settings > On-phone models: GGUF models that run offline on the phone (the YakkBot app's llama.cpp). */
export function PhoneModels() {
  const bot = useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [repos, setRepos] = useState<{ repo: string; downloads: number }[] | null>(null);
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => call<Status>('').then((d) => { setS(d); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setNote(null);
    try { await fn(); if (done) setNote(done); load(); } catch (e) { setNote((e as Error).message); }
  };
  const use = (file: string) => act(async () => {
    if (!bot) throw new Error('Open a bot first.');
    await configApi.setEngine(bot.id, { provider: 'phone', model: file });
  }, bot ? `${bot.name} now uses ${file.replace(/\.gguf$/, '')} on this phone. The first reply loads it, which can take a minute.` : undefined);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setFiles(null); setRepos(null); setNote(null);
    try {
      if (q.includes('/')) setFiles((await call<{ files: HfFile[] }>('/files', { repo: q })).files);
      else setRepos((await call<{ results: { repo: string; downloads: number }[] }>('/search', { q })).results);
    } catch (e) { setNote((e as Error).message); }
    setBusy(false);
  };

  if (error && !s) return <div className="cfg-empty">{error}</div>;
  if (!s) return <div className="cfg-empty">Loading…</div>;
  if (!s.engine) return <div className="cfg-empty">This build of the app has no on-phone model engine. Update the YakkBot app.</div>;

  const installed = new Set(s.installed.map((m) => m.file));
  const downloading = new Map(s.downloads.map((d) => [d.file, d]));
  const row = (file: string, title: string, sub: string, bytes: number, fits = true, download?: () => void) => {
    const d = downloading.get(file);
    const have = installed.has(file);
    return (
      <div className="cfg-row" key={file}>
        <div className="cfg-row__text">
          <div className="cfg-row__title">{title}{s.running === file && <span className="cfg-chip" style={{ marginLeft: 8 }}>Loaded</span>}</div>
          <div className="cfg-row__sub">{sub} · {gb(bytes)}{!fits && ' · needs more memory than this phone has'}</div>
          {d && !d.failed && <div className="cfg-meter__track" style={{ marginTop: 6 }}><span style={{ width: `${d.total > 0 ? Math.max(2, (100 * d.done) / d.total) : 2}%` }} /></div>}
          {d?.failed && <div className="card__error">The download failed.</div>}
        </div>
        {have ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => use(file)}>Use</button>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => act(() => call('/delete', { file }))}>Delete</button>
          </span>
        ) : d ? (
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => act(() => call('/cancel', { file }))}>{d.failed ? 'Clear' : `${d.total > 0 ? Math.round((100 * d.done) / d.total) : 0}% · Cancel`}</button>
        ) : (
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={download}>Download</button>
        )}
      </div>
    );
  };

  const others = s.installed.filter((m) => !s.catalog.some((c) => c.file === m.file));
  return (
    <>
      <div className="app-settings__head">
        <h1>On-phone models</h1>
        <p>Models that run on this phone, offline and free, instead of through an API key. Smaller ones reply faster; larger ones are smarter. This phone has {s.ramGb} GB of memory.</p>
      </div>
      {note && <div className="cfg-field__hint" role="status">{note}</div>}
      {s.state === 'failed' && s.error && <div className="card__error">{s.error.slice(-300)}</div>}
      <section className="cfg-section">
        <div className="cfg-section__label">Suggested</div>
        <div className="cfg-card">
          {s.catalog.map((m) => row(m.file, `${m.name}${m.id === s.recommended ? ' (best for this phone)' : ''}`, `${m.maker} · ${m.tag}. ${m.note}`, m.bytes, m.fits, () => act(() => call('/download', { id: m.id }), `Downloading ${m.name}. It keeps going with the app closed.`)))}
        </div>
      </section>
      {others.length > 0 && (
        <section className="cfg-section">
          <div className="cfg-section__label">Your other models</div>
          <div className="cfg-card">{others.map((m) => row(m.file, m.file.replace(/\.gguf$/, ''), 'Downloaded', m.bytes))}</div>
        </section>
      )}
      <section className="cfg-section">
        <div className="cfg-section__label">Any GGUF from Hugging Face</div>
        <form className="cfg-row" onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ gap: 8 }}>
          <input className="text-input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, or owner/name like bartowski/Qwen_Qwen3.5-2B-GGUF" aria-label="Search Hugging Face" />
          <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
        </form>
        {repos && (
          <div className="cfg-card">
            {repos.length === 0 && <div className="cfg-empty">Nothing found.</div>}
            {repos.map((r) => (
              <div className="cfg-row" key={r.repo}>
                <div className="cfg-row__text"><div className="cfg-row__title">{r.repo}</div><div className="cfg-row__sub">{r.downloads.toLocaleString()} downloads</div></div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setQ(r.repo); setRepos(null); setBusy(true); call<{ files: HfFile[] }>('/files', { repo: r.repo }).then((d) => setFiles(d.files)).catch((e) => setNote(e.message)).finally(() => setBusy(false)); }}>Files</button>
              </div>
            ))}
          </div>
        )}
        {files && (
          <div className="cfg-card">
            {files.length === 0 && <div className="cfg-empty">No .gguf files in that repository.</div>}
            {files.map((h) => row(h.file, h.file.replace(/\.gguf$/, ''), h.repo, h.bytes, h.bytes / 1e9 < s.ramGb * 0.6, () => act(() => call('/download', { url: h.url, file: h.file }), `Downloading ${h.file}.`)))}
          </div>
        )}
        <div className="cfg-field__hint">Pick a Q4_K_M file when there is a choice: it is the usual balance of size and quality. A model needs roughly its file size in free memory.</div>
      </section>
    </>
  );
}
