import { useCallback, useEffect, useState } from 'react';
import { android } from '../lib/android';

type Droid = { checkUpdate?(): void; lastUpdateCheck?(): string; installUpdate?(url: string): void; updateStatus?(): string; appVersion?(): string };
const droid = android as unknown as Droid | undefined;
interface Check { current?: string; latest?: string; url?: string; available?: boolean; error?: string }
interface Status { state: 'idle' | 'downloading' | 'installing' | 'done' | 'failed'; progress: number; error: string }

const LS = 'yakkbot.updateCheck';

/** Ask the app for the newest release (on a background thread, since it goes to GitHub). */
async function check(): Promise<Check> {
  if (!droid?.checkUpdate || !droid.lastUpdateCheck) return {};
  droid.checkUpdate();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try { const j = JSON.parse(droid.lastUpdateCheck()); if (!j.checking && (j.current || j.error)) return j; } catch { /* keep waiting */ }
  }
  return { error: 'GitHub did not answer in time.' };
}

/** The update control: version, Check for updates, and Update with progress. `compact` is the banner. */
export function UpdateCard({ compact = false }: { compact?: boolean }) {
  const [c, setC] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [st, setSt] = useState<Status | null>(null);
  const [hidden, setHidden] = useState(false);

  const run = useCallback(async () => {
    setChecking(true);
    const r = await check();
    setC(r);
    setChecking(false);
    try { localStorage.setItem(LS, JSON.stringify({ at: Date.now(), r })); } catch { /* fine */ }
  }, []);

  useEffect(() => {
    if (!droid?.checkUpdate) return;
    try {
      const saved = JSON.parse(localStorage.getItem(LS) ?? 'null');
      if (saved && Date.now() - saved.at < 6 * 3600_000 && saved.r?.current === droid.appVersion?.()) { setC(saved.r); if (!compact) void run(); return; }
    } catch { /* check now */ }
    void run();
  }, [compact, run]);

  useEffect(() => {
    if (!st || (st.state !== 'downloading' && st.state !== 'installing')) return;
    const t = setInterval(() => { try { setSt(JSON.parse(droid!.updateStatus!())); } catch { /* keep */ } }, 700);
    return () => clearInterval(t);
  }, [st]);

  if (!droid?.checkUpdate) return compact ? null : <div className="cfg-field__hint">Updates: install the newest yakkbot.apk from the YakkBot releases page.</div>;
  const update = () => { if (c?.url) { droid.installUpdate?.(c.url); setSt({ state: 'downloading', progress: 0, error: '' }); } };
  const busy = st?.state === 'downloading' || st?.state === 'installing';

  if (compact) {
    if (!c?.available || hidden) return null;
    return (
      <div className="update-banner">
        <span>YakkBot {c.latest} is ready.</span>
        <button type="button" className="update-banner__btn" onClick={update} disabled={busy}>{busy ? (st?.state === 'downloading' ? `${st.progress}%` : 'Installing…') : 'Update'}</button>
        <button type="button" className="update-banner__x" onClick={() => setHidden(true)} aria-label="Later">×</button>
      </div>
    );
  }
  return (
    <div className="cfg-card">
      <div className="cfg-row">
        <div className="cfg-row__text">
          <div className="cfg-row__title">YakkBot {droid.appVersion?.() ?? c?.current ?? ''}</div>
          <div className="cfg-row__sub">
            {checking ? 'Checking for updates…'
              : c?.error ? `Could not check: ${c.error}`
              : c?.available ? `Version ${c.latest} is ready. Your chats, models and computer stay as they are.`
              : c?.latest ? 'You have the newest version.' : 'Updates install with one tap.'}
          </div>
          {busy && <div className="get-computer__bar"><i style={{ width: `${st?.state === 'installing' ? 100 : st?.progress ?? 0}%` }} /></div>}
          {st?.state === 'failed' && <div className="cfg-error">{st.error}</div>}
        </div>
        {c?.available
          ? <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={update}>{busy ? (st?.state === 'downloading' ? `Downloading ${st.progress}%` : 'Installing…') : 'Update'}</button>
          : <button type="button" className="cfg-btn cfg-btn--secondary" disabled={checking} onClick={run}>Check for updates</button>}
      </div>
    </div>
  );
}
