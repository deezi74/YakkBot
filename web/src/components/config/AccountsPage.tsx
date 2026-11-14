import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';

interface Data {
  accounts: { id: string; kind: 'email' | 'github'; label: string }[];
  emailPresets: { id: string; name: string; help: string }[];
  composio: { connected: boolean; fromServer: boolean };
}
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`/api${path}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};

/** Settings › Accounts: the owner's email, GitHub, and 250+ other apps, connected for the Bots. */
export function AccountsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preset, setPreset] = useState('gmail');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [token, setToken] = useState('');
  const [ckey, setCkey] = useState('');
  const setModal = useStore((s) => s.setModal);
  const load = useCallback(() => call('GET', '/accounts').then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label); setError(null); setNote(null);
    try { await fn(); setNote(done); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!d) return <div className="app-settings__head"><h1>Accounts</h1><p>{error ?? 'Loading…'}</p></div>;
  const emails = d.accounts.filter((a) => a.kind === 'email');
  const github = d.accounts.find((a) => a.kind === 'github');
  const help = d.emailPresets.find((p) => p.id === preset)?.help;

  return (
    <>
      <div className="app-settings__head">
        <h1>Accounts</h1>
        <p>Connect your accounts so Bots can work in them for you: clean up your email, build websites and apps on GitHub, and use 250+ other apps. Passwords and tokens stay on this device. Deleting or sending email always asks you first.</p>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Email</div>
        <div className="cfg-card">
          {emails.map((a) => (
            <div key={a.id} className="cfg-row">
              <span className="acct-icon" aria-hidden>✉️</span>
              <div className="cfg-row__text"><div className="cfg-row__title">{a.label}</div><div className="cfg-row__sub">Bots can read, organize, delete and send.</div></div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => run('rm', () => call('DELETE', `/accounts/${a.id}`), 'Removed.')}>Remove</button>
            </div>
          ))}
          <form className="cfg-row cfg-row--stack" onSubmit={(e) => { e.preventDefault(); run('email', () => call('POST', '/accounts/email', { preset, address, password, imapHost, smtpHost }), 'Email connected.').then(() => { setPassword(''); }); }}>
            <div className="cfg-row__title">{emails.length ? 'Add another email' : 'Connect your email'}</div>
            <select className="text-input" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Email provider">
              {d.emailPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {help && <div className="cfg-row__sub">App password: {help}</div>}
            <input className="text-input" type="email" placeholder="you@example.com" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Email address" autoComplete="off" />
            <input className="text-input" type="password" placeholder="App password (not your normal password)" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="App password" autoComplete="off" />
            {preset === 'other' && <>
              <input className="text-input" placeholder="IMAP server, e.g. imap.example.com" value={imapHost} onChange={(e) => setImapHost(e.target.value)} aria-label="IMAP server" />
              <input className="text-input" placeholder="SMTP server, e.g. smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} aria-label="SMTP server" />
            </>}
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy || !address || !password}>{busy === 'email' ? 'Signing in…' : 'Connect email'}</button>
            <div className="cfg-row__sub">Outlook and Hotmail no longer allow app passwords; connect them under Other apps below.</div>
          </form>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">GitHub</div>
        <div className="cfg-card">
          {github ? (
            <div className="cfg-row">
              <span className="acct-icon" aria-hidden>🐙</span>
              <div className="cfg-row__text"><div className="cfg-row__title">{github.label}</div><div className="cfg-row__sub">Bots can create repositories, write code and publish websites.</div></div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => run('rm', () => call('DELETE', `/accounts/${github.id}`), 'Removed.')}>Remove</button>
            </div>
          ) : (
            <form className="cfg-row cfg-row--stack" onSubmit={(e) => { e.preventDefault(); run('gh', () => call('POST', '/accounts/github', { token }), 'GitHub connected.').then(() => setToken('')); }}>
              <div className="cfg-row__title">Connect GitHub</div>
              <div className="cfg-row__sub">
                Create a token at <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=YakkBot" target="_blank" rel="noreferrer">github.com/settings/tokens</a> with the <code>repo</code> and <code>workflow</code> boxes ticked, then paste it here.
              </div>
              <input className="text-input" type="password" placeholder="ghp_… or github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} aria-label="GitHub token" autoComplete="off" />
              <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy || !token.trim()}>{busy === 'gh' ? 'Checking…' : 'Connect GitHub'}</button>
            </form>
          )}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Other apps (Google, Outlook, Slack, Notion, X and 250+ more)</div>
        <div className="cfg-card">
          {d.composio.connected ? (
            <div className="cfg-row">
              <span className="acct-icon" aria-hidden>🧩</span>
              <div className="cfg-row__text"><div className="cfg-row__title">App connections are on</div><div className="cfg-row__sub">Sign in to each app with one tap. Bots then use them directly.</div></div>
              <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setModal('apps')}>Connect apps</button>
            </div>
          ) : (
            <form className="cfg-row cfg-row--stack" onSubmit={(e) => { e.preventDefault(); run('cp', () => call('PUT', '/accounts/composio', { key: ckey }), 'App connections are on. Reloading…').then(() => setTimeout(() => location.reload(), 800)); }}>
              <div className="cfg-row__title">Turn on app connections</div>
              <div className="cfg-row__sub">
                Uses Composio, which handles the secure sign-in to each app (free to start). Sign up at <a href="https://platform.composio.dev" target="_blank" rel="noreferrer">platform.composio.dev</a>, copy your API key, and paste it here. Then you can connect Gmail, Google Drive, Calendar, Outlook, Slack, Notion, Discord, X, Dropbox and many more with one tap each.
              </div>
              <input className="text-input" type="password" placeholder="Composio API key" value={ckey} onChange={(e) => setCkey(e.target.value)} aria-label="Composio API key" autoComplete="off" />
              <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!!busy || !ckey.trim()}>Turn on</button>
            </form>
          )}
        </div>
      </section>
      {note && <div className="cfg-field__hint" role="status">{note}</div>}
      {error && <div className="cfg-error">{error}</div>}
    </>
  );
}
