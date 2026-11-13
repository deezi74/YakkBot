import { useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { useFeatures, useStore } from '../store';

export function SignIn() {
  const f = useFeatures();
  const checkAuth = useStore((s) => s.checkAuth);
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (new URLSearchParams(location.search).get('login') === 'failed' ? 'Sign-in didn’t finish. Try again.' : null));

  const run = async (go: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await go(); await checkAuth(); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };
  const withPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) { setError('Enter your passphrase'); return; }
    void run(() => api.passwordLogin(password));
  };
  const dev = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    void run(() => api.devLogin(email.trim(), name.trim() || undefined));
  };
  const nothing = !f.passwordLogin && !f.googleLogin && !f.devLogin;

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__hero">
          <BotAvatar shape="squircle" color="orange" size={84} />
        </div>
        <h1 className="signin__title">YakkBot</h1>
        <p className="signin__sub">Your own team of AI agents. Text them a job and they get it done.</p>
        {f.passwordLogin && (
          <form className="signin__dev" onSubmit={withPassword}>
            <input className="text-input" type="password" placeholder="Passphrase" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Passphrase" autoComplete="current-password" autoFocus />
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        {f.googleLogin && (
          <a className="btn btn--secondary signin__google" href="/api/auth/google/start">Sign in with Google</a>
        )}
        {f.devLogin && (
          <form className="signin__dev" onSubmit={dev}>
            <div className="signin__divider"><span>Dev sign-in</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="text-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Continue with email'}</button>
          </form>
        )}
        {nothing && <div className="card__error signin__error">No sign-in is set up. On the device running YakkBot, run <code>yakkbot password</code> to set a passphrase.</div>}
        {error && <div className="card__error signin__error">{error}</div>}
        <p className="signin__foot">Runs on your own device. Your passphrase is in <code>~/.yakkbot/.env</code>.</p>
      </div>
    </div>
  );
}
