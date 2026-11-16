import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type RFBType from '@novnc/novnc';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText, screenSize, screensFull } from '../lib/computer';
import { configApi } from '../lib/configApi';
import { activityStatus } from '../lib/phrases';
import { useFeatures, useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';

export type ScreenMode = 'watch' | 'control';
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
const POINTER_VERB: Record<string, string> = { click: 'clicking', double_click: 'double-clicking', move: 'pointing', drag: 'dragging', scroll: 'scrolling', type: 'typing' };
type Phase = 'live' | 'switching' | 'waking' | 'asleep' | 'idle' | 'paused' | 'error';

interface ScreenProps {
  bot: Bot;
  /** 'panel' is the small live view in the details panel; 'stage' is the large view. */
  variant: 'panel' | 'stage';
  initialMode?: ScreenMode;
  /** Replaces "You're driving" under the frame, e.g. a sign-in the person has to finish. */
  hint?: string | null;
  /** Stop streaming and show a placeholder (the large view has this screen). */
  paused?: boolean;
  /** Panel only: the person asked for the large view, in this mode. */
  onExpand?: (mode: ScreenMode) => void;
  onModeChange?: (mode: ScreenMode) => void;
}

/**
 * A bot's screen on the shared computer: noVNC over our relay inside a rounded frame that keeps the
 * screen's aspect ratio. Watching is view-only. Taking control reconnects with mode=control and shows
 * a chin under the frame with the way back.
 */
export function ComputerScreen({ bot, variant, initialMode = 'watch', hint, paused = false, onExpand, onModeChange }: ScreenProps) {
  const computer = useStore((s) => s.computer);
  const f = useFeatures();
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const hadFrame = useRef(false);
  const autoWoke = useRef(false);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [conn, setConn] = useState<Conn>('idle');
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [opened, setOpened] = useState(variant === 'stage');
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [resetAsk, setResetAsk] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const status = computer?.status;
  const running = status === 'running';
  const busy = status === 'creating' || status === 'starting' || status === 'resuming';
  const hasScreen = !!computer?.screens.some((s) => s.botId === bot.id);
  const { width, height } = screenSize(computer, bot.id, bot.isPrimary);
  const driving = mode === 'control';
  const live = useStore((s) => s.live[bot.id]);
  // The frame's caption: what the bot is up to, in a few words. The cursor label follows its last pointing action.
  const doing = live?.isRunning ? activityStatus(live, []) : live?.awaiting ? 'Needs you' : 'Idle';
  const cursor = live?.isRunning && live.cursor && Date.now() - live.cursor.at < 60_000 ? live.cursor : null;
  const large = variant === 'stage' || fullscreen;
  // The small panel view only streams a screen that already exists, so browsing bots never uses up screens.
  const wantLive = running && !paused && (variant === 'stage' || visible) && (opened || hasScreen);

  const wake = useCallback(() => {
    setWaking(true); setWakeError(null);
    api.ensureComputer()
      .then(() => useStore.getState().loadComputer())
      .catch((e: Error) => setWakeError(e.message || 'The computer did not start.'))
      .finally(() => setWaking(false));
  }, []);

  // Opening the large view is a request to see the computer, so wake it without another click.
  useEffect(() => {
    if (variant !== 'stage' || autoWoke.current || !computer) return;
    if (status === 'suspended' || status === 'stopped' || status === 'absent') { autoWoke.current = true; wake(); }
  }, [variant, computer, status, wake]);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useEffect(() => {
    if (!wantLive || !canvasRef.current) { setConn('idle'); return; }
    let disposed = false;
    let rfb: RFBType | null = null;
    setConn('connecting');
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !canvasRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${mode}`;
      rfb = new RFB(canvasRef.current, url, { shared: true });
      rfb.viewOnly = mode === 'watch';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = mode === 'control';
      rfb.addEventListener('connect', () => { if (!disposed) { hadFrame.current = true; setConn('connected'); if (mode === 'control') rfb?.focus(); } });
      rfb.addEventListener('disconnect', (e) => { if (!disposed) setConn((e as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error'); });
      rfb.addEventListener('securityfailure', () => { if (!disposed) setConn('error'); });
      rfbRef.current = rfb;
    })().catch(() => { if (!disposed) setConn('error'); });
    const el = canvasRef.current;
    return () => {
      disposed = true;
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfbRef.current = null;
      el.innerHTML = '';
    };
  }, [bot.id, wantLive, mode, attempt]);

  useEffect(() => { onModeChange?.(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handBack = useCallback(() => {
    setMode('watch');
    // The bot carries on either way; this only tells it sooner.
    configApi.handback(bot.id).catch(() => {});
  }, [bot.id]);

  // The panel view is too small to drive: control there only exists in full screen, and ends with it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (variant === 'panel' && !fullscreen && modeRef.current === 'control') handBack();
  }, [variant, fullscreen, handBack]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  useEffect(() => {
    if (!resetAsk) return;
    const t = setTimeout(() => setResetAsk(false), 6000);
    return () => clearTimeout(t);
  }, [resetAsk]);

  let phase: Phase;
  if (paused) phase = 'paused';
  else if (status === 'error' || wakeError) phase = 'error';
  else if (!running) phase = busy || waking ? 'waking' : 'asleep';
  else if (!opened && !hasScreen) phase = 'idle';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = hadFrame.current ? 'switching' : 'waking';

  const localDesk = f.computer === 'local';
  const takeControl = () => {
    if (variant === 'panel' && !fullscreen) onExpand?.('control');
    else setMode('control');
  };
  // The computer is up but its screen did not answer (often: the phone was busy): try again by itself a few times.
  const autoRetries = useRef(0);
  useEffect(() => {
    if (phase === 'live') { autoRetries.current = 0; return; }
    if (phase !== 'error' || !running || autoRetries.current >= 3) return;
    const t = setTimeout(() => { autoRetries.current += 1; setAttempt((n) => n + 1); }, 4000);
    return () => clearTimeout(t);
  }, [phase, running]);
  const [restarting, setRestarting] = useState(false);
  const [desktopLog, setDesktopLog] = useState('');
  // In the phone app the computer runs on the phone: when its screen does not answer, restart it there.
  const appDesktop = typeof window !== 'undefined' && !!(window as unknown as { YakkAndroid?: unknown }).YakkAndroid;
  useEffect(() => {
    if (!appDesktop || phase !== 'error') return;
    fetch('/api/desktop', { credentials: 'include' }).then((r) => r.json()).then((d) => setDesktopLog(d?.running === false ? String(d.log ?? '').trim().split('\n').slice(-4).join('\n') : '')).catch(() => {});
  }, [appDesktop, phase]);
  const retry = async () => {
    setWakeError(null);
    if (appDesktop) {
      setRestarting(true);
      await fetch('/api/desktop/restart', { method: 'POST', credentials: 'include' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 8000));
      setRestarting(false);
      setAttempt((n) => n + 1);
      return;
    }
    if (running) setAttempt((n) => n + 1);
    else wake();
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frameRef.current?.requestFullscreen().catch(() => setNote('Full screen isn’t available here.'));
  };
  const reset = async () => {
    setResetting(true);
    try { await configApi.resetScreen(bot.id); setAttempt((n) => n + 1); }
    catch { setNote('Couldn’t reset the screen.'); }
    finally { setResetting(false); setResetAsk(false); }
  };

  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const expandable = variant === 'panel' && !fullscreen && phase === 'live';
  const mascot = large ? 64 : 40;
  const style = { ...botVars(bot.avatarColor), ['--screen-ratio' as string]: String(width / height) } as CSSProperties;

  return (
    <div
      ref={frameRef}
      className={`screen screen--${variant} is-${phase}${driving ? ' is-driving' : ''}${fullscreen ? ' is-fullscreen' : ''}${localDesk && phase === 'live' && !driving ? ' has-dock' : ''}`}
      style={style}
    >
      <div className="screen__body">
        <div className="screen__view" style={{ aspectRatio: `${width} / ${height}` }}>
          <div ref={canvasRef} className="screen__canvas" />
          {phase === 'live' && !driving && cursor && (
            <span
              key={cursor.at}
              className="screen__cursor"
              style={{ left: `${Math.min(100, (cursor.x / width) * 100)}%`, top: `${Math.min(100, (cursor.y / height) * 100)}%` }}
              aria-hidden
            >
              <svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 2.5 19.5 12l-7 1.6L9 20.5Z" /></svg>
              <span className="screen__cursor-label">{bot.name} is {POINTER_VERB[cursor.action] ?? 'working'}</span>
            </span>
          )}
          {/* noVNC swallows clicks on its canvas, so the way into the large view is a button laid over it. */}
          {expandable && <button type="button" className="screen__expand" onClick={() => onExpand?.('watch')} aria-label={`Open ${bot.name}’s computer in the large view`} title="Open the large view" />}

          {phase === 'live' && !driving && (
            <span className="screen__badge" aria-hidden>
              <BotAvatarFor bot={bot} size={16} />
              <span>Live</span>
              <i className="screen__live-dot" />
            </span>
          )}

          {phase === 'waking' && (
            <div className="screen__state is-waking" role="status">
              <span className="screen__sweep" aria-hidden />
              <span className="screen__mascot is-bobbing"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__label">{running ? `Connecting to ${bot.name}’s screen…` : `Waking ${bot.name}’s computer…`}</span>
            </div>
          )}
          {running && (phase === 'waking' || phase === 'switching' || phase === 'error') && <ScreenDetails />}
          {phase === 'switching' && (
            <div className="screen__state" role="status">
              <span className="screen__text">One moment…</span>
            </div>
          )}
          {phase === 'asleep' && (
            <div className="screen__state">
              <span className="screen__mascot is-asleep"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{status === 'suspending' ? 'Going to sleep…' : `${bot.name}’s computer is asleep`}</span>
              {status !== 'suspending' && <button type="button" className="screen__action" onClick={wake}>Wake it up</button>}
            </div>
          )}
          {phase === 'idle' && (
            <div className="screen__state">
              <span className="screen__mascot"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{bot.name} hasn’t opened a screen yet</span>
              {screensFull(computer, bot.id)
                ? <span className="screen__sub">All {computer?.maxScreens} screens are in use. Reset one in Settings to free it.</span>
                : <button type="button" className="screen__action" onClick={() => setOpened(true)}>Open its screen</button>}
            </div>
          )}
          {phase === 'paused' && (
            <div className="screen__state">
              <span className="screen__text">Open in the large view</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="screen__state" role="alert">
              <span className="screen__text">
                {!running ? `Couldn’t wake ${bot.name}’s computer` : conn === 'disconnected' ? 'The screen disconnected' : `Couldn’t reach ${bot.name}’s screen`}
              </span>
              {(wakeError || (status === 'error' && computer?.error)) && <span className="screen__sub">{wakeError ?? computer?.error}</span>}
              {desktopLog && <pre className="screen__log">{desktopLog}</pre>}
              {running && screensFull(computer, bot.id) && <span className="screen__sub">All {computer?.maxScreens} screens are in use. Reset one in Settings to free it.</span>}
              <button type="button" className="screen__action" onClick={retry} disabled={restarting}>{restarting ? 'Restarting the computer…' : appDesktop ? 'Restart computer' : 'Retry'}</button>
            </div>
          )}

          {phase === 'live' && !driving && (
            <div className={`screen__pill${resetAsk || note ? ' is-pinned' : ''}`} role="toolbar" aria-label="Screen controls">
              {note ? <span className="screen__pill-text" role="status">{note}</span> : resetAsk ? (
                <>
                  <span className="screen__pill-text">Close all windows?</span>
                  <button type="button" className="screen__pill-btn is-danger" onClick={reset} disabled={resetting}>{resetting ? 'Resetting…' : 'Reset'}</button>
                  <button type="button" className="screen__pill-btn" onClick={() => setResetAsk(false)} disabled={resetting}>Cancel</button>
                </>
              ) : (
                <>
                  <div className="screen__seg" role="group" aria-label="Who is using the screen">
                    <button type="button" className="screen__seg-btn is-active" aria-pressed="true">{large && <Icon name="eye" size={14} />}Watch</button>
                    <button type="button" className="screen__seg-btn" aria-pressed="false" onClick={takeControl}>{large && <Icon name="pointer" size={14} />}Take control</button>
                  </div>
                  <span className="screen__pill-rule" aria-hidden />
                  {canFullscreen && (
                    <button type="button" className="screen__pill-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                      <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                    </button>
                  )}
                  <button type="button" className="screen__pill-icon" onClick={() => setResetAsk(true)} aria-label="Reset screen" title="Reset: close everything on this screen">
                    <Icon name="refresh" size={15} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {!driving && (
          <>
            {localDesk && phase === 'live' && <Dock onNote={setNote} />}
            <div className="screen__caption">
              <BotAvatarFor bot={bot} size={18} />
              <span className="screen__caption-name">{bot.name}</span>
              <span className="screen__caption-dot" aria-hidden>{live?.isRunning ? 'has control ·' : '·'}</span>
              <span className={`screen__caption-doing${live?.isRunning ? ' is-busy' : ''}`}>{doing}</span>
              {phase === 'live' && <button type="button" className="screen__takeover" onClick={takeControl}>Take over</button>}
            </div>
          </>
        )}

        {driving && (
          <div className="screen__chin">
            <span className="screen__chin-text" role="status">
              <i className="screen__ping" aria-hidden />
              <span>{hint || 'You’re driving'}</span>
            </span>
            <span className="screen__chin-actions">
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              <button type="button" className="screen__handback" onClick={handBack}>
                <BotAvatarFor bot={bot} size={18} />
                <span>Hand back to {bot.name}</span>
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The large computer view: the bot's screen on a dimmed stage, opened from the chat menu or the details panel. */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const computer = useStore((s) => s.computer);
  const initialMode = useStore((s) => s.viewerMode);
  const hint = useStore((s) => s.viewerHint);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const botId = bot?.id;

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (mode === 'control' && botId) configApi.handback(botId).catch(() => {});
    set({ viewerOpen: false, viewerMode: 'watch', viewerHint: null });
  }, [mode, botId, set]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // While driving, Escape belongs to the remote desktop. In full screen the browser uses it to leave.
      if (e.key === 'Escape' && mode === 'watch' && !document.fullscreenElement) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mode, close]);

  const onModeChange = useCallback((m: ScreenMode) => {
    setMode(m);
    // A hint belongs to one stretch of driving; it goes once the person hands back.
    set(m === 'watch' ? { viewerMode: m, viewerHint: null } : { viewerMode: m });
  }, [set]);

  if (!bot) return null;

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${bot.name}’s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" onClick={mode === 'watch' ? close : undefined} />
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{bot.name}’s computer</span>
          <span className="viewer__status">{computerStatusText(computer)}</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close computer"><Icon name="close" color="#FFFFFF" /></button>
      </div>
      <div className="viewer__stage">
        <ComputerScreen key={bot.id} bot={bot} variant="stage" initialMode={initialMode} hint={hint} onModeChange={onModeChange} />
      </div>
    </div>
  );
}

interface DeskAppInfo { id: string; name: string; icon: string; tint: string; installed: boolean; installing: boolean; available: boolean; about: string }

/** The dock under the screen of the computer on this device: the everyday apps, and every other app a tap away. */
function Dock({ onNote }: { onNote: (t: string | null) => void }) {
  const [apps, setApps] = useState<DeskAppInfo[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { fetch('/api/computer/apps', { credentials: 'include' }).then((r) => r.json()).then((d) => setApps(d.apps ?? [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!apps.some((a) => a.installing)) return; const t = setTimeout(load, 4000); return () => clearTimeout(t); }, [apps, load]);
  const act = async (a: DeskAppInfo) => {
    const r = await fetch(`/api/computer/apps/${a.id}/${a.installed ? 'open' : 'install'}`, { method: 'POST', credentials: 'include' }).then((x) => x.json()).catch(() => null);
    onNote(r?.message ?? null);
    setTimeout(() => onNote(null), 3500);
    setOpen(false);
    load();
  };
  const pinned = ['browser', 'terminal', 'files'].map((id) => apps.find((a) => a.id === id)).filter((a): a is DeskAppInfo => !!a && (a.installed || a.available));
  return (
    <div className="screen__dock-wrap">
      {open && (
        <div className="screen__apps" role="menu">
          {apps.filter((a) => a.installed || a.available).map((a) => (
            <button key={a.id} type="button" role="menuitem" className={`screen__app${a.installed ? '' : ' is-off'}${a.installing ? ' is-busy' : ''}`} onClick={() => act(a)} title={a.about}>
              <span className="screen__app-icon" style={{ background: a.tint }}>{a.icon}</span>
              <span className="screen__app-name">{a.name}{!a.installed && !a.installing ? ' · Get' : a.installing ? ' · …' : ''}</span>
            </button>
          ))}
        </div>
      )}
      <div className="screen__dock">
        {pinned.map((a) => (
          <button key={a.id} type="button" className={`screen__dock-btn${a.installed ? '' : ' is-off'}`} onClick={() => act(a)} title={a.installed ? `Open ${a.name}` : `Install ${a.name}`} aria-label={a.name}>
            <span style={{ background: a.tint }}>{a.icon}</span>
          </button>
        ))}
        <button type="button" className="screen__dock-btn" onClick={() => setOpen(!open)} title="All apps" aria-label="All apps" aria-expanded={open}>
          <span style={{ background: '#FFFFFF' }}>▦</span>
        </button>
      </div>
    </div>
  );
}

/** What the connection is doing, step by step, so a screen that will not open can be diagnosed from a screenshot. */
function ScreenDetails() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('Checking…');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => fetch('/api/computer/diagnose', { credentials: 'include' }).then((r) => r.json()).then((d) => {
      if (!alive) return;
      const lines = [
        `Screen ${d.screen}: ${d.screenAnswer}`,
        ...(d.attempts ?? []).map((a: { step: string; ms: number; ago: number; error?: string }) => `${a.ago}s ago · ${a.step} after ${a.ms}ms${a.error ? ` · ${a.error}` : ''}`),
        d.desktop ? `Desktop: ${d.desktop.error ?? `${d.desktop.state ?? ''}${d.desktop.running === false ? ', screen not running' : ''}`}` : '',
        ...String(d.desktop?.log ?? '').trim().split('\n').slice(-6),
      ].filter(Boolean);
      setText(lines.join('\n'));
    }).catch((e) => alive && setText(String(e)));
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [open]);
  return (
    <div className="screen__details">
      <button type="button" className="screen__details-btn" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>
      {open && <pre className="screen__details-text">{text}</pre>}
    </div>
  );
}
