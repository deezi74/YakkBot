import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore, useFeatures } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { Glyph } from './glyphs';
import { PhoneModels } from './PhoneModels';
import { AiModels } from './AiModels';
import { android, androidInfo, pairAndroid, type AndroidInfo } from '../../lib/android';
import { ConfirmButton } from './ui';
import { ComputerSetupCard } from './ComputerSetup';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI models' },
  { id: 'phone', label: 'Phone control' },
  { id: 'models', label: 'On-device models' },
  { id: 'computer', label: 'Computer' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'account', label: 'Account' },
];

/** Full-window settings page, opened from the account menu. */
export function AppSettings() {
  const f = useFeatures();
  const sections = SECTIONS.filter((s) => (s.id === 'computer' ? true : s.id === 'apps' ? f.apps : s.id === 'phone' ? f.phone || !!android : s.id === 'models' ? f.models : true));
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Settings</div>
        {sections.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'general' && <GeneralSection />}
          {section === 'phone' && <PhoneSection />}
          {section === 'models' && <PhoneModels />}
          {section === 'ai' && <AiModels />}
          {section === 'computer' && <ComputerSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'apps' && <AppsSection />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
          <ThemeTile value="light" label="Light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting.</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const f = useFeatures();
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  // The server says how many screens the computer can hold; 4 until it does.
  const maxScreens = computer?.maxScreens ?? details?.computer.maxScreens ?? 4;

  return (
    <>
      <PageHead title="Computer" sub="Your Bots share one computer. Each Bot works on its own screen, which you can watch live or take over." />
      <ComputerSetupCard />
      {f.computer === 'none' ? null : <>
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots’ computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a Bot has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Screens in use{details && maxScreens ? ` · ${details.screens.length} of ${maxScreens}` : ''}</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that Bot’s screen, so it starts clean next time.{maxScreens ? ` Up to ${maxScreens} Bots can have a screen at once${details && details.screens.length >= maxScreens ? '; reset one to free it for another Bot' : ''}.` : ''}</div>
      </section>
      </>}
    </>
  );
}

// ---------------------------------------------------------------------------

function humanizeTool(slug: string): { app: string; action: string } {
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

function PermissionsSection() {
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[] | null>(null);
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="Actions your Bots can take without asking first. Remove one and they’ll ask again next time." />
      <section className="cfg-section">
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = humanizeTool(p.tool);
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code></div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>Ask again</button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

function AppsSection() {
  const version = useStore((s) => s.connectionsVersion);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  useEffect(() => { configApi.connectedApps().then((r) => setApps(r.connectedApps ?? [])).catch(() => setApps([])); }, [version]);
  const openApps = () => { useConfigUI.getState().closeAppSettings(); useStore.getState().setModal('apps'); };
  return (
    <>
      <PageHead title="Connected apps" sub="Apps your Bots can use for you, like email, calendar and docs." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{apps === null ? 'Checking…' : apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} connected` : 'No apps connected yet'}</div>
              <div className="cfg-row__sub">Bots ask before doing anything that changes data in an app.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={openApps}>{apps?.length ? 'Manage apps' : 'Connect apps'}</button>
          </div>
          {apps?.map((a) => (
            <div key={a.slug} className="cfg-row">
              <ToolkitLogo name={a.name} logo={a.logo} size={28} radius={7} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{a.name}</div>
                {a.description && <div className="cfg-row__sub">{a.description}</div>}
              </div>
              <span className="cfg-chip">Connected</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

const APK_URL = 'https://github.com/deezi74/YakkBot/releases/latest/download/yakkbot.apk';

const PERMISSION_ROWS = [
  { key: 'sms', title: 'Texts', on: 'Bots can send and read texts (they ask you first).', off: 'Off. Bots cannot send or read texts.' },
  { key: 'calls', title: 'Calls', on: 'Bots can place calls and read your call history.', off: 'Off. Bots can only open the dialer.' },
  { key: 'contacts', title: 'Contacts', on: 'Bots can look people up by name.', off: 'Off. Bots need a number to text or call.' },
  { key: 'calendar', title: 'Calendar', on: 'Bots can read and add events.', off: 'Off.' },
  { key: 'location', title: 'Location', on: 'Bots can tell where the phone is.', off: 'Off.' },
  { key: 'notifications', title: 'Notifications from bots', on: 'Bots can notify you when they finish.', off: 'Off. Bots cannot notify you.' },
];

/** Use YakkBot from a PC on the same Wi-Fi: the phone stays the server. */
function PcAccess({ lan }: { lan: boolean }) {
  const [on, setOn] = useState(lan);
  const [pass, setPass] = useState('');
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Use it from your PC</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Open to your Wi-Fi</div>
            <div className="cfg-row__sub">{on ? 'On your PC, open http://<this phone’s Wi-Fi address>:8787 and sign in with the passphrase.' : 'Only this phone can open YakkBot.'}</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { const next = !on; setOn(next); android?.setLan?.(next); }}>{on ? 'Turn off' : 'Turn on'}</button>
        </div>
        {on && (
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Passphrase</div>
              <div className="cfg-row__sub"><code>{pass || '••••••••••••••••'}</code></div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPass(pass ? '' : android?.passphrase?.() ?? '')}>{pass ? 'Hide' : 'Show'}</button>
          </div>
        )}
      </div>
      <div className="cfg-field__hint">Only turn this on at home. Anyone on the same Wi-Fi who has the passphrase can use your bots.</div>
    </section>
  );
}

/** The Android app's bridge: what the bots may do on the phone itself, and the switches for it. */
function PhoneSection() {
  const [state, setState] = useState<{ paired: boolean; reachable: boolean } | null>(null);
  const [info, setInfo] = useState<AndroidInfo | null>(() => androidInfo());
  const refresh = useCallback(() => {
    setInfo(androidInfo());
    pairAndroid().then(() => configApi.device()).then((d) => { setState(d); if (!android && d.info) setInfo(d.info as AndroidInfo); }).catch(() => setState({ paired: false, reachable: false }));
  }, []);
  useEffect(() => {
    refresh();
    // Coming back from Android's settings screens: read the switches again.
    const onShow = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [refresh]);

  const Row = ({ on, title, sub, action, onAction }: { on: boolean | undefined; title: string; sub: string; action?: string; onAction?: () => void }) => (
    <div className="cfg-row">
      <span className={`computer-status-dot is-${on ? 'on' : 'off'}`} aria-hidden />
      <div className="cfg-row__text">
        <div className="cfg-row__title">{title}</div>
        <div className="cfg-row__sub">{sub}</div>
      </div>
      {action && onAction && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onAction}>{action}</button>}
    </div>
  );

  return (
    <>
      <PageHead title="Phone control" sub="With the YakkBot Android app, your bots can use the phone itself: read the screen, tap, type, open apps and read notifications. They ask you before they start." />
      <section className="cfg-section">
        <div className="cfg-card">
          <Row on={state?.reachable} title={state?.reachable ? 'The app is connected' : state?.paired ? 'The app is not answering' : 'The app is not connected'}
            sub={state?.reachable ? [info?.device, info?.version && `app ${info.version}`].filter(Boolean).join(' · ') : state?.paired ? 'Open the YakkBot app; Android may have stopped it.' : android ? 'Connecting…' : 'Install the YakkBot app and open it once.'}
            action={!android ? 'Get the app' : undefined} onAction={() => window.open(APK_URL, '_blank')} />
          {(android || state?.paired) && (
            <>
              <Row on={info?.screenControl} title="Screen control" sub={info?.screenControl ? 'Bots can read the screen and tap, swipe and type.' : 'Off. Turn on “YakkBot phone control” in Accessibility settings.'} action={android && !info?.screenControl ? 'Turn on' : undefined} onAction={() => android?.openAccessibilitySettings()} />
              <Row on={info?.notifications} title="Notifications" sub={info?.notifications ? 'Bots can read and clear notifications.' : 'Off. Allow YakkBot in notification access.'} action={android && !info?.notifications ? 'Turn on' : undefined} onAction={() => android?.openNotificationSettings()} />
              {PERMISSION_ROWS.map((p) => {
                const on = info?.permissions?.[p.key];
                if (on === undefined) return null;
                return <Row key={p.key} on={on} title={p.title} sub={on ? p.on : p.off} action={android && !on ? 'Allow' : undefined} onAction={() => android?.grant?.(p.key)} />;
              })}
              <Row on={info?.unrestrictedBattery} title="Runs in the background" sub={info?.unrestrictedBattery ? 'Android will not put the app to sleep.' : 'Android may stop the app when it is in the background.'} action={android && !info?.unrestrictedBattery ? 'Allow' : undefined} onAction={() => android?.requestBattery()} />
            </>
          )}
        </div>
        <div className="cfg-field__hint">Bots still ask you before they text, call, read your messages or touch the screen. What you said “Always allow” to is listed under Permissions, where you can take it back.</div>
      </section>
      {android?.setLan && <PcAccess lan={!!info?.lan} />}
    </>
  );
}

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
