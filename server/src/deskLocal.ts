import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { db } from './db.js';
import { dataDir, env } from './env.js';
import { displayEnv } from './computer.js';
import { avatarSvg, colorHex, paletteFor, wallpaperSvg } from './desk.js';
import { pkgInstall } from './services.js';

/**
 * The home of the computer that runs on this device (the app's own Linux, Termux, or a PC desktop):
 * the page its browser opens to, in the bot's colours, with a clock, a welcome, and a shelf of apps
 * the bot or the owner can open, or install with one tap. The desktop's browser has no sign-in, so
 * these routes use a token kept next to the data, which the desktop script reads.
 */
export const deskApi = new Hono();

const tokenFile = path.join(dataDir, 'desk.token');
export function deskToken(): string {
  try { const t = fs.readFileSync(tokenFile, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* make one */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, t, { mode: 0o600 });
  return t;
}
const okToken = (t: unknown) => typeof t === 'string' && t.length >= 32 && crypto.timingSafeEqual(Buffer.from(t.padEnd(64).slice(0, 64)), Buffer.from(deskToken().padEnd(64).slice(0, 64)));
export const deskHomeUrl = () => `http://127.0.0.1:${env.port}/desk/home?t=${deskToken()}`;

// ---------- apps ----------

export interface DeskApp { id: string; name: string; icon: string; tint: string; cmd: string; args?: string[]; pkg: { alpine?: string; termux?: string; debian?: string }; about: string; big?: boolean }

export const DESK_APPS: DeskApp[] = [
  { id: 'browser', name: 'Browser', icon: '🌐', tint: '#DCEBFF', cmd: 'browser|chromium-browser|chromium|firefox', args: [`--user-data-dir=${path.join(process.env.HOME ?? '/root', '.config', 'yakkbot-browser')}`, '--remote-debugging-port=9222'], pkg: { alpine: 'chromium', termux: 'chromium', debian: 'chromium' }, about: 'Chromium web browser' },
  { id: 'terminal', name: 'Terminal', icon: '⌨️', tint: '#E4E4E7', cmd: 'xfce4-terminal', pkg: { alpine: 'xfce4-terminal', termux: 'xfce4-terminal', debian: 'xfce4-terminal' }, about: 'Command line' },
  { id: 'files', name: 'Files', icon: '📁', tint: '#DDF0FF', cmd: 'thunar', pkg: { alpine: 'thunar', termux: 'thunar', debian: 'thunar' }, about: 'File manager' },
  { id: 'editor', name: 'Text editor', icon: '📝', tint: '#FFF4D6', cmd: 'mousepad', pkg: { alpine: 'mousepad', termux: 'mousepad', debian: 'mousepad' }, about: 'Simple text and code editor' },
  { id: 'code', name: 'Code', icon: '🧑‍💻', tint: '#E3F7EA', cmd: 'geany', pkg: { alpine: 'geany', termux: 'geany', debian: 'geany' }, about: 'Code editor with projects' },
  { id: 'draw', name: 'Draw', icon: '🖍️', tint: '#FFE7EF', cmd: 'drawing', pkg: { alpine: 'drawing', debian: 'drawing' }, about: 'Quick sketches and edits' },
  { id: 'gimp', name: 'GIMP', icon: '🖌️', tint: '#EEE7DD', cmd: 'gimp', pkg: { alpine: 'gimp', termux: 'gimp', debian: 'gimp' }, about: 'Photo editing', big: true },
  { id: 'inkscape', name: 'Inkscape', icon: '✒️', tint: '#E9E9F7', cmd: 'inkscape', pkg: { alpine: 'inkscape', termux: 'inkscape', debian: 'inkscape' }, about: 'Vector drawing, logos', big: true },
  { id: 'krita', name: 'Krita', icon: '🎨', tint: '#F3E6FF', cmd: 'krita', pkg: { alpine: 'krita', debian: 'krita' }, about: 'Digital painting', big: true },
  { id: 'blender', name: 'Blender', icon: '🧊', tint: '#FFE9DA', cmd: 'blender', pkg: { alpine: 'blender', debian: 'blender' }, about: '3D modeling and animation', big: true },
  { id: 'freecad', name: 'FreeCAD', icon: '📐', tint: '#FFE3E3', cmd: 'freecad', pkg: { alpine: 'freecad', debian: 'freecad' }, about: '3D CAD design', big: true },
  { id: 'kicad', name: 'KiCad', icon: '🔌', tint: '#E1E8FF', cmd: 'kicad', pkg: { alpine: 'kicad', debian: 'kicad' }, about: 'Circuit boards', big: true },
  { id: 'kdenlive', name: 'Kdenlive', icon: '🎬', tint: '#E0F2FF', cmd: 'kdenlive', pkg: { alpine: 'kdenlive', debian: 'kdenlive' }, about: 'Video editing', big: true },
  { id: 'obs', name: 'OBS', icon: '🎥', tint: '#E6E6E6', cmd: 'obs', pkg: { alpine: 'obs-studio', debian: 'obs-studio' }, about: 'Screen recording', big: true },
  { id: 'audacity', name: 'Audacity', icon: '🎙️', tint: '#E3F1FF', cmd: 'audacity', pkg: { alpine: 'audacity', debian: 'audacity' }, about: 'Audio editing', big: true },
  { id: 'lmms', name: 'LMMS', icon: '🎹', tint: '#E8FFE8', cmd: 'lmms', pkg: { alpine: 'lmms', debian: 'lmms' }, about: 'Make music', big: true },
  { id: 'vlc', name: 'VLC', icon: '▶️', tint: '#FFEBD9', cmd: 'vlc', pkg: { alpine: 'vlc', termux: 'vlc', debian: 'vlc' }, about: 'Play any video or audio' },
  { id: 'office', name: 'Office', icon: '📊', tint: '#E3F5E8', cmd: 'libreoffice', pkg: { alpine: 'libreoffice', debian: 'libreoffice' }, about: 'Documents, sheets, slides', big: true },
  { id: 'photos', name: 'Photos', icon: '🖼️', tint: '#FFF0E0', cmd: 'ristretto', pkg: { alpine: 'ristretto', termux: 'ristretto', debian: 'ristretto' }, about: 'Image viewer' },
  { id: 'calc', name: 'Calculator', icon: '🧮', tint: '#F0F0F0', cmd: 'galculator', pkg: { alpine: 'galculator', termux: 'galculator', debian: 'galculator' }, about: 'Calculator' },
];

const has = (cmd: string) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };
/** A command may have other names on other systems ("browser|chromium-browser|chromium"): the first one present. */
const resolveCmd = (cmd: string) => cmd.split('|').find(has) ?? null;
const which = (cmd: string) => !!resolveCmd(cmd);
let installedCache: { at: number; ids: Set<string> } = { at: 0, ids: new Set() };
function installed(): Set<string> {
  if (Date.now() - installedCache.at < 8000) return installedCache.ids;
  installedCache = { at: Date.now(), ids: new Set(DESK_APPS.filter((a) => which(a.cmd)).map((a) => a.id)) };
  return installedCache.ids;
}

const installing = new Map<string, { state: 'running' | 'failed'; error?: string }>();

function pkgFor(a: DeskApp): string | null {
  if (env.isTermux) return a.pkg.termux ?? null;
  if (which('apk')) return a.pkg.alpine ?? null;
  return a.pkg.debian ?? a.pkg.alpine ?? null;
}

export function deskApps() {
  const have = installed();
  return DESK_APPS.map((a) => ({
    id: a.id, name: a.name, icon: a.icon, tint: a.tint, about: a.about, big: !!a.big,
    installed: have.has(a.id), installing: installing.get(a.id)?.state === 'running', error: installing.get(a.id)?.error,
    available: !!pkgFor(a),
  }));
}

export function launchApp(id: string, args: string[] = []): { ok: boolean; message: string } {
  const a = DESK_APPS.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!a) return { ok: false, message: `No app called ${id}. Apps: ${DESK_APPS.map((x) => x.name).join(', ')}.` };
  if (!which(a.cmd)) return { ok: false, message: `${a.name} is not installed yet. Install it first (it is on the computer's home page).` };
  const child = spawn(resolveCmd(a.cmd)!, [...(a.args ?? []), ...args.map(String)], { env: { ...displayEnv(), NO_AT_BRIDGE: '1' }, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, message: `Opened ${a.name}.` };
}

export function installApp(id: string): { ok: boolean; message: string } {
  const a = DESK_APPS.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!a) return { ok: false, message: `No app called ${id}.` };
  if (which(a.cmd)) return { ok: true, message: `${a.name} is already installed.` };
  if (installing.get(a.id)?.state === 'running') return { ok: true, message: `${a.name} is installing.` };
  const pkg = pkgFor(a);
  if (!pkg) return { ok: false, message: `${a.name} is not available on this device.` };
  installing.set(a.id, { state: 'running' });
  const p = spawn('sh', ['-c', pkgInstall(pkg, pkg, pkg)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
  p.on('close', () => {
    installedCache.at = 0;
    if (which(a.cmd)) installing.delete(a.id);
    else installing.set(a.id, { state: 'failed', error: err.trim().split('\n').pop() || 'The install did not finish.' });
  });
  return { ok: true, message: `Installing ${a.name}. ${a.big ? 'It is a big app; this can take a while.' : ''}`.trim() };
}

/**
 * Makes the desktop's Chromium open the home page on start, on Home and in new tabs (managed policy).
 * Written where Chromium reads policies on Alpine and Debian; skipped where it cannot be written.
 */
/** The home page's app icons are emoji; computers set up before it was part of the install get the font now. */
function ensureEmojiFont() {
  if (!has('apk') || fs.existsSync('/usr/share/fonts/noto/NotoColorEmoji.ttf')) return;
  const p = spawn('apk', ['add', '--no-progress', 'font-noto-emoji'], { stdio: 'ignore', detached: true });
  p.unref();
}

export function writeBrowserPolicy() {
  // Only on the phone (the app's Linux, or Termux): elsewhere the system's browser settings are not ours to change.
  if (process.env.YAKK_PLATFORM !== 'android-app' && !env.isTermux) { try { fs.writeFileSync(path.join(dataDir, 'desk.url'), deskHomeUrl() + '\n', { mode: 0o600 }); } catch { /* fine */ } return; }
  ensureEmojiFont();
  const url = deskHomeUrl();
  const policy = JSON.stringify({ HomepageLocation: url, HomepageIsNewTabPage: false, NewTabPageLocation: url, ShowHomeButton: true, RestoreOnStartup: 4, RestoreOnStartupURLs: [url], BrowserSignin: 0, PromotionalTabsEnabled: false, DefaultBrowserSettingEnabled: false }, null, 2);
  for (const dir of ['/etc/chromium/policies/managed', process.env.PREFIX ? `${process.env.PREFIX}/etc/chromium/policies/managed` : '']) {
    if (!dir) continue;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'yakkbot.json'), policy); } catch { /* not ours to write */ }
  }
  try { fs.writeFileSync(path.join(dataDir, 'desk.url'), url + '\n', { mode: 0o600 }); } catch { /* fine */ }
}

// ---------- the page ----------

/** The bot shown on the home page: the one using the screen last, else the main bot. */
function homeBot(id?: string): { id: string; name: string; avatarShape: string; avatarColor: string } {
  const pick = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as any[])) as any;
  const b = (id && pick("SELECT id,name,avatar_shape,avatar_color FROM bots WHERE id=? AND COALESCE(kind,'agent')<>'room'", id))
    ?? pick("SELECT b.id,b.name,b.avatar_shape,b.avatar_color FROM screens s JOIN bots b ON b.id=s.bot_id ORDER BY s.last_used_at DESC LIMIT 1")
    ?? pick("SELECT id,name,avatar_shape,avatar_color FROM bots WHERE is_primary=1 LIMIT 1")
    ?? pick("SELECT id,name,avatar_shape,avatar_color FROM bots WHERE COALESCE(kind,'agent')<>'room' ORDER BY created_at LIMIT 1");
  return b ? { id: b.id, name: b.name, avatarShape: b.avatar_shape ?? 'blob', avatarColor: b.avatar_color ?? 'blue' } : { id: 'yakk', name: 'YakkBot', avatarShape: 'blob', avatarColor: 'blue' };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function homeHtml(token: string, botId?: string): string {
  const bot = homeBot(botId);
  const hex = colorHex(bot.avatarColor);
  const p = paletteFor(hex);
  const wall = wallpaperSvg(p, bot.id).replace('__W__', '1600').replace('__H__', '1000');
  const avatar = avatarSvg(bot.avatarShape, hex);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(bot.name)}'s computer</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(avatar)}">
<style>
  :root { --accent: ${p.accent}; --ink: ${p.ink}; --wash: ${p.wash}; --deep: ${p.washDeep}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif; color: var(--ink); }
  body { background: var(--wash) url("data:image/svg+xml,${encodeURIComponent(wall)}") center / cover no-repeat fixed; overflow-x: hidden; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; padding: 6vh 24px 48px; }
  .hello { position: relative; display: flex; flex-direction: column; align-items: center; }
  .bubble { position: relative; max-width: 260px; margin-bottom: 10px; padding: 10px 30px 10px 14px; border-radius: 14px; background: #fff; box-shadow: 0 6px 20px -8px #0003; font-size: 13px; line-height: 18px; }
  .bubble::after { content: ''; position: absolute; left: 50%; bottom: -7px; width: 14px; height: 14px; background: #fff; transform: translateX(-50%) rotate(45deg); }
  .bubble button { position: absolute; top: 6px; right: 8px; border: 0; background: none; font-size: 15px; cursor: pointer; color: #0007; }
  .mascot { width: 124px; height: 124px; filter: drop-shadow(0 10px 16px #0002); animation: bob 3.2s ease-in-out infinite; }
  .mascot svg { width: 100%; height: 100%; }
  @keyframes bob { 50% { transform: translateY(-6px); } }
  .clock { margin-top: 10px; font-size: 76px; font-weight: 600; letter-spacing: -2px; line-height: 1; }
  .clock small { font-size: 15px; font-weight: 600; letter-spacing: 0; margin-left: 4px; }
  .welcome { margin-top: 8px; font-size: 20px; opacity: .85; }
  form { margin-top: 22px; width: min(560px, 100%); }
  form input { width: 100%; height: 46px; padding: 0 18px; border: 0; border-radius: 23px; background: #fffd; box-shadow: 0 4px 16px -8px #0003, 0 0 0 1px #0000000d; font-size: 15px; outline: none; color: inherit; }
  form input:focus { box-shadow: 0 0 0 2px var(--accent); }
  .apps { margin-top: 30px; display: grid; grid-template-columns: repeat(auto-fill, 92px); justify-content: center; gap: 16px 14px; width: min(760px, 100%); }
  .app { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 2px; border: 0; border-radius: 16px; background: none; cursor: pointer; color: inherit; font: inherit; }
  .app:hover { background: #ffffff70; }
  .icon { display: flex; align-items: center; justify-content: center; width: 54px; height: 54px; border-radius: 15px; font-size: 28px; box-shadow: 0 4px 10px -6px #0004, inset 0 0 0 1px #0000000a; }
  .name { font-size: 12px; text-align: center; line-height: 15px; }
  .app.off .icon { filter: grayscale(.7); opacity: .55; }
  .tag { position: absolute; top: 4px; right: 10px; padding: 1px 6px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 10px; font-weight: 700; }
  .app.busy .icon { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(.92); opacity: .6; } }
  .note { margin-top: 18px; min-height: 18px; font-size: 13px; opacity: .8; }
</style></head><body><main>
  <div class="hello">
    <div class="bubble" id="bubble">This is my computer. Watch me work here, or take over whenever you like.<button id="x" aria-label="Close">×</button></div>
    <div class="mascot">${avatar}</div>
  </div>
  <div class="clock" id="clock"></div>
  <div class="welcome">Welcome back, ${esc(bot.name)}</div>
  <form action="https://www.google.com/search" method="get"><input name="q" placeholder="Search the web or type an address" autocomplete="off"></form>
  <div class="apps" id="apps"></div>
  <div class="note" id="note"></div>
</main>
<script>
  const T = ${JSON.stringify(token)};
  const clock = () => { const d = new Date(); let h = d.getHours(); const pm = h >= 12; h = h % 12 || 12;
    document.getElementById('clock').innerHTML = h + ':' + String(d.getMinutes()).padStart(2, '0') + '<small>' + (pm ? 'PM' : 'AM') + '</small>'; };
  clock(); setInterval(clock, 5000);
  try { if (localStorage.getItem('yakk-bubble') === 'off') document.getElementById('bubble').remove(); } catch (e) {}
  document.getElementById('x')?.addEventListener('click', () => { document.getElementById('bubble').remove(); try { localStorage.setItem('yakk-bubble', 'off'); } catch (e) {} });
  document.querySelector('form').addEventListener('submit', (e) => { const v = e.target.q.value.trim(); if (/^(https?:\\/\\/|[\\w-]+\\.[a-z]{2,}(\\/|$))/i.test(v)) { e.preventDefault(); location.href = /^https?:/.test(v) ? v : 'https://' + v; } });
  const note = (t) => { document.getElementById('note').textContent = t || ''; };
  async function load() {
    const r = await fetch('/desk/apps?t=' + T); const apps = await r.json();
    const box = document.getElementById('apps'); box.innerHTML = '';
    for (const a of apps) {
      if (!a.installed && !a.available) continue;
      const b = document.createElement('button');
      b.className = 'app' + (a.installed ? '' : ' off') + (a.installing ? ' busy' : '');
      b.title = a.about + (a.installed ? '' : a.installing ? ' (installing…)' : ' (tap to install)');
      b.innerHTML = '<span class="icon" style="background:' + a.tint + '">' + a.icon + '</span><span class="name"></span>' + (!a.installed && !a.installing ? '<span class="tag">GET</span>' : '');
      b.querySelector('.name').textContent = a.name;
      b.onclick = async () => {
        const path = a.installed ? 'launch' : 'install';
        const res = await fetch('/desk/' + path + '?t=' + T, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }) });
        const j = await res.json(); note(j.message); load();
      };
      box.appendChild(b);
    }
    if (apps.some((a) => a.installing)) setTimeout(load, 4000);
  }
  load();
</script></body></html>`;
}

deskApi.use('*', async (c, next) => {
  if (!okToken(c.req.query('t'))) return c.text('Not found', 404);
  await next();
});
deskApi.get('/home', (c) => c.html(homeHtml(c.req.query('t')!, c.req.query('bot'))));
deskApi.get('/apps', (c) => c.json(deskApps()));
deskApi.post('/launch', async (c) => { const p = await c.req.json<{ id?: string }>().catch(() => ({} as any)); return c.json(launchApp(String(p.id ?? ''))); });
deskApi.post('/install', async (c) => { const p = await c.req.json<{ id?: string }>().catch(() => ({} as any)); return c.json(installApp(String(p.id ?? ''))); });

// ---------- showing the bot's work on the screen ----------

/** The desktop's browser listens for remote control here (started with --remote-debugging-port). */
const CDP = `http://127.0.0.1:${process.env.YAKK_DESK_CDP_PORT ?? 9222}`;
let botTab: string | null = null;
let lastShown = { url: '', at: 0 };

/**
 * Opens a page the bot is working with in the computer's browser, so whoever is watching sees it.
 * One tab is the bot's: each new page replaces the last one there. Quiet and best effort: if the
 * computer is off or its browser is not listening, nothing happens and the bot's work goes on.
 */
export async function showOnScreen(url: string): Promise<boolean> {
  if (env.computerMode !== 'local' || !/^https?:\/\//i.test(url)) return false;
  if (url === lastShown.url && Date.now() - lastShown.at < 10_000) return true;
  lastShown = { url, at: Date.now() };
  try {
    const r = await fetch(`${CDP}/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const tab = (await r.json()) as { id?: string };
    const old = botTab;
    botTab = tab.id ?? null;
    if (botTab) await fetch(`${CDP}/json/activate/${botTab}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    if (old && old !== botTab) await fetch(`${CDP}/json/close/${old}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    return true;
  } catch { return false; /* the computer is not up: nothing to show */ }
}
