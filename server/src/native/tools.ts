import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { cdpUrlFor, displayEnv, hasLocalDesktop, localScreenshot, screenFor, screenForWork } from '../computer.js';
import { box } from '../box.js';
import { orgo } from '../orgo.js';
import type { ActivityKind } from '../types.js';
import { bridge, bridgePhone, bridgeUsable } from '../device.js';
import { ensureHome, entries, MEMORY_LIMIT, readHomeFile, SEP, USER_LIMIT, writeHomeFile } from './home.js';
import type { Image, ToolSpec } from './llm.js';

/**
 * The built-in engine's own tools: what a bot can do on the device the server runs on.
 * On a phone that device is Termux, so the shell, the files and the Termux:API bridge (SMS,
 * notifications, location, camera...) are the bot's computer.
 */

export interface DeviceCtx { userId: string; botId: string; signal: AbortSignal }
export interface DeviceResult { output: string; summary?: string; isError?: boolean; image?: Image }

/** What a call needs before it may run. `key` is what "Always allow" remembers. */
export interface Gate { key: string; title: string }

export interface DeviceTool extends ToolSpec {
  activity: ActivityKind;
  label: string;
  /** Returns a gate when this call should wait for the user's OK. */
  gate?: (args: any) => Gate | null;
  impl: (args: any, ctx: DeviceCtx) => Promise<DeviceResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.floor(n * 0.6))}\n…(${s.length - n} characters left out)…\n${s.slice(-Math.floor(n * 0.4))}` : s);

const has = (bin: string): boolean => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};
const haveCache = new Map<string, boolean>();
const have = (bin: string) => { let v = haveCache.get(bin); if (v === undefined) haveCache.set(bin, (v = has(bin))); return v; };

/** The bot's working folder: its Library, so what it makes shows up in the app. */
export function workspace(botId: string): string {
  const dir = path.join(env.libraryRoot, botId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const resolveIn = (botId: string, p: string) => path.resolve(workspace(botId), expand(String(p ?? '')));

/** The server's own secrets never reach a command the model wrote. */
function shellEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(_KEY|_TOKEN|_SECRET|PASSWORD|^SESSION_SECRET$|^HERMES_KEY$)/i.test(k)) continue;
    out[k] = v;
  }
  if (hasLocalDesktop()) out.DISPLAY = env.display;
  return out;
}

// ---------- shell ----------

const RISKY: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rRf]/, 'delete files'],
  [/\b(mkfs|fdisk|parted|wipefs)\b|\bdd\b[^|;&]*\bof=/, 'write to a disk'],
  [/>\s*\/dev\/(sd|nvme|block|mmc)/, 'write to a disk'],
  [/\b(shutdown|reboot|poweroff|halt)\b/, 'restart the device'],
  [/\b(sudo|su|tsu|doas)\b/, 'run as root'],
  [/\b(chmod|chown)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*R/, 'change permissions recursively'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'run a script from the internet'],
  [/\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr|release|repo)\s+(create|delete|merge)\b/, 'publish to a remote'],
  [/\b(pkill|killall)\b|\bkill\s+-(9|KILL)\b/, 'stop running programs'],
  [/\btermux-(sms-send|telephony-call)\b|\bam\s+start\b.*\b(CALL|SENDTO)\b/, 'send a text or make a call'],
  [/\b(pm|cmd\s+package)\s+(uninstall|clear)\b|\b(apt|apt-get|pkg|pacman|dnf)\s+(remove|purge|autoremove)\b/, 'remove software'],
  [/\b(ssh|scp|sftp|rsync)\s+[^|;&]*@/, 'connect to another machine'],
  [/\bcrontab\s+-r\b|\b(fastboot|flash_image)\b|\badb\s+(shell\s+)?(reboot|uninstall|push|sideload)\b/, 'change the system'],
  [/:\(\)\s*\{.*\};\s*:/, 'run a fork bomb'],
  [/(^|[\s;&|])>\s*~?\/?(\.bashrc|\.profile|\.zshrc|\.ssh\/)/, 'change your shell or SSH setup'],
];

function shellGate(args: any): Gate | null {
  if (env.shellApproval === 'off') return null;
  const cmd = String(args?.command ?? '');
  if (env.shellApproval === 'always') return { key: 'SHELL_RUN_A_COMMAND', title: 'Shell: run a command' };
  const hit = RISKY.find(([re]) => re.test(cmd));
  return hit ? { key: `SHELL_${hit[1].toUpperCase().replace(/\s+/g, '_')}`, title: `Shell: ${hit[1]}` } : null;
}

function runShell(command: string, cwd: string, timeoutSec: number, signal: AbortSignal): Promise<{ output: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const file = win ? 'powershell.exe' : have('bash') ? 'bash' : 'sh';
    const argv = win ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    let out = '';
    let timedOut = false;
    const child = spawn(file, argv, { cwd, env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !win });
    const kill = () => {
      try { if (!win && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    const onAbort = () => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    const take = (d: Buffer) => { if (out.length < 400_000) out += d.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ output: `Could not start the shell: ${e.message}`, code: 127, timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ output: out, code: code ?? (timedOut ? 124 : 1), timedOut }); });
  });
}

// ---------- web ----------

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${String(label).replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function webSearch(query: string, count: number): Promise<string> {
  if (process.env.TAVILY_API_KEY) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: count }), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Search failed (${r.status})`);
    const j: any = await r.json();
    return (j.results ?? []).map((x: any, i: number) => `${i + 1}. ${x.title}\n${x.url}\n${String(x.content ?? '').slice(0, 400)}`).join('\n\n') || 'No results.';
  }
  if (process.env.BRAVE_API_KEY) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?count=${count}&q=${encodeURIComponent(query)}`, { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Search failed (${r.status})`);
    const j: any = await r.json();
    return (j.web?.results ?? []).map((x: any, i: number) => `${i + 1}. ${x.title}\n${x.url}\n${htmlToText(String(x.description ?? '')).slice(0, 400)}`).join('\n\n') || 'No results.';
  }
  // No search key: DuckDuckGo's plain HTML results.
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Search failed (${r.status})`);
  const html = await r.text();
  const out: string[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < count) {
    let url = m[1].replace(/&amp;/g, '&');
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    out.push(`${out.length + 1}. ${htmlToText(m[2])}\n${url}\n${htmlToText(m[3] ?? '').slice(0, 400)}`);
  }
  return out.join('\n\n') || 'No results (the search page may have asked for a human check; try web_fetch on a known site instead).';
}

// ---------- phone (Termux:API) ----------

const termux = (cmd: string, args: string[] = [], timeout = 30_000, input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim().slice(0, 300)}. Is the Termux:API app installed and allowed?`));
      else resolve(String(stdout).trim());
    });
    if (input !== undefined) { child.stdin?.write(input); child.stdin?.end(); }
  });

const PHONE_READ_PRIVATE = new Set(['sms_list', 'contacts', 'call_log', 'location', 'calendar_events']);
const PHONE_OUTWARD = new Set(['sms_send', 'call', 'calendar_add']);
const PHONE_ACTIONS = ['battery', 'device', 'wifi', 'location', 'notify', 'toast', 'vibrate', 'speak', 'clipboard_get', 'clipboard_set', 'sms_list', 'sms_send', 'call', 'contacts', 'call_log', 'photo', 'torch', 'volume', 'open_url', 'share', 'alarm', 'timer', 'calendar_events', 'calendar_add', 'maps'] as const;
/** Only the YakkBot Android app can do these; Termux:API has no command for them. */
const APP_ONLY = new Set(['alarm', 'timer', 'calendar_events', 'calendar_add', 'maps']);

async function phone(a: any, ctx: DeviceCtx): Promise<DeviceResult> {
  // Inside the YakkBot Android app, the app itself does the phone's jobs with Android permissions.
  if (bridgePhone()) {
    const r = await bridge('/phone', a ?? {}, 90_000);
    return { output: String(r.output ?? 'Done.'), ...(r.summary ? { summary: String(r.summary) } : {}), ...(r.image ? { image: { mime: r.mime ?? 'image/jpeg', data: r.image } } : {}) };
  }
  if (APP_ONLY.has(a?.action)) return { output: `${a.action} needs the YakkBot Android app. Termux:API cannot do it.`, isError: true };
  const s = (v: unknown) => String(v ?? '');
  switch (a.action) {
    case 'battery': return { output: await termux('termux-battery-status') };
    case 'device': return { output: await termux('termux-telephony-deviceinfo') };
    case 'wifi': return { output: await termux('termux-wifi-connectioninfo') };
    case 'location': return { output: await termux('termux-location', ['-p', a.precise ? 'gps' : 'network', '-r', 'once'], 60_000) };
    case 'notify': await termux('termux-notification', ['--title', s(a.title) || 'YakkBot', '--content', s(a.text)]); return { output: 'Notification shown.', summary: 'Notified you' };
    case 'toast': await termux('termux-toast', [s(a.text)]); return { output: 'Shown.' };
    case 'vibrate': await termux('termux-vibrate', ['-d', String(Math.min(Number(a.ms) || 400, 3000))]); return { output: 'Vibrated.' };
    case 'speak': await termux('termux-tts-speak', [s(a.text).slice(0, 2000)], 120_000); return { output: 'Spoken aloud.' };
    case 'clipboard_get': return { output: await termux('termux-clipboard-get') };
    case 'clipboard_set': await termux('termux-clipboard-set', [], 10_000, s(a.text)); return { output: 'Copied to the clipboard.' };
    case 'sms_list': return { output: clip(await termux('termux-sms-list', ['-l', String(Math.min(Number(a.limit) || 10, 50)), ...(a.number ? ['-f', s(a.number)] : [])]), 20_000) };
    case 'sms_send':
      if (!a.number || !a.text) return { output: 'sms_send needs number and text.', isError: true };
      await termux('termux-sms-send', ['-n', s(a.number), s(a.text)]);
      return { output: `Text sent to ${a.number}.`, summary: `Texted ${a.number}` };
    case 'call':
      if (!a.number) return { output: 'call needs number.', isError: true };
      await termux('termux-telephony-call', [s(a.number)]);
      return { output: `Calling ${a.number}.`, summary: `Called ${a.number}` };
    case 'contacts': return { output: clip(await termux('termux-contact-list'), 30_000) };
    case 'call_log': return { output: clip(await termux('termux-call-log', ['-l', String(Math.min(Number(a.limit) || 10, 50))]), 20_000) };
    case 'photo': {
      const file = path.join(workspace(ctx.botId), `photo-${Date.now()}.jpg`);
      await termux('termux-camera-photo', ['-c', a.front ? '1' : '0', file], 60_000);
      const data = fs.readFileSync(file);
      return { output: `Photo saved to ${file}`, summary: 'Took a photo', ...(data.length < 4_000_000 ? { image: { mime: 'image/jpeg', data: data.toString('base64') } } : {}) };
    }
    case 'torch': await termux('termux-torch', [a.on === false ? 'off' : 'on']); return { output: 'Done.' };
    case 'volume':
      if (a.stream && a.level !== undefined) { await termux('termux-volume', [s(a.stream), String(Number(a.level) || 0)]); return { output: 'Volume set.' }; }
      return { output: await termux('termux-volume') };
    case 'open_url': await termux('termux-open-url', [s(a.url)]); return { output: 'Opened on the phone.' };
    case 'share': await termux('termux-share', ['-a', 'send', resolveIn(ctx.botId, s(a.path))]); return { output: 'Share sheet opened.' };
    default: return { output: `Unknown action "${a.action}". Use one of: ${PHONE_ACTIONS.join(', ')}.`, isError: true };
  }
}

// ---------- screen (local desktop) ----------

const xdo = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    execFile('xdotool', args, { env: displayEnv(), timeout: 15_000 }, (err, _o, stderr) => (err ? reject(new Error(`xdotool: ${String(stderr || err.message).trim().slice(0, 200)}`)) : resolve()));
  });

/** The bot's own screen on the team's Orgo computer: every action goes through Orgo's API to that screen. */
async function orgoScreen(a: any, ctx: DeviceCtx): Promise<DeviceResult> {
  await screenForWork(ctx.userId, ctx.botId);
  const { computerId, screenId } = await screenFor(ctx.userId, ctx.botId);
  const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
  switch (a.action) {
    case 'screenshot': break;
    case 'move': await orgo.move(computerId, screenId, { x: n(a.x), y: n(a.y) }); break;
    case 'click': await orgo.click(computerId, screenId, { x: n(a.x), y: n(a.y), button: a.button === 'right' || a.button === 'middle' ? a.button : 'left' }); break;
    case 'double_click': await orgo.click(computerId, screenId, { x: n(a.x), y: n(a.y), double: true }); break;
    case 'drag': await orgo.drag(computerId, screenId, { start_x: n(a.x), start_y: n(a.y), end_x: n(a.x2), end_y: n(a.y2) }); break;
    case 'type': {
      // Orgo types about 2,500 characters per call at most.
      const text = String(a.text ?? '');
      for (let i = 0; i < text.length; i += 2000) await orgo.type(computerId, screenId, text.slice(i, i + 2000));
      break;
    }
    case 'key': await orgo.key(computerId, screenId, String(a.keys ?? a.key ?? '').trim().split(/\s+/).join('+')); break;
    case 'scroll': await orgo.scroll(computerId, screenId, { x: n(a.x) || 640, y: n(a.y) || 360, direction: a.direction === 'up' ? 'up' : 'down', amount: Math.min(n(a.amount) || 3, 20) }); break;
    case 'open_url': {
      const url = String(a.url ?? '');
      if (!/^https?:\/\//i.test(url)) return { output: 'open_url needs an http(s) address.', isError: true };
      // A new tab in the bot's own Chrome on its screen, through Chrome's DevTools port.
      const devtools = cdpUrlFor(ctx.botId, screenId);
      const r = await box.bash(`curl -s -X PUT ${box.quote(`${devtools}/json/new?${url}`)} >/dev/null || (google-chrome ${box.quote(url)} >/dev/null 2>&1 &)`, 30, screenId);
      if (r.exit_code !== 0) return { output: `Could not open the page: ${r.output.slice(0, 300)}`, isError: true };
      await new Promise((res) => setTimeout(res, 2500));
      break;
    }
    case 'shell': {
      const r = await box.bash(String(a.command ?? a.text ?? ''), Math.min(Math.max(n(a.timeout) || 120, 1), 290), screenId);
      return { output: (r.output || '(no output)').slice(-30_000) + (r.exit_code ? `\n[exit code ${r.exit_code}]` : ''), isError: r.exit_code !== 0 };
    }
    default: return { output: 'Unknown action. Use screenshot, click, double_click, move, drag, type, key, scroll, open_url or shell.', isError: true };
  }
  if (a.action !== 'screenshot') await new Promise((r) => setTimeout(r, 700));
  const shot = await orgo.screenshot(computerId, screenId);
  return {
    output: a.action === 'screenshot' ? `Your screen right now (${shot.width}x${shot.height}).` : `Done. Your screen after the action (${shot.width}x${shot.height}) is attached.`,
    image: { mime: shot.mime_type ?? 'image/jpeg', data: String(shot.image).replace(/^data:[^,]+,/, '') },
  };
}

async function screen(a: any): Promise<DeviceResult> {
  const xy = () => [String(Math.round(Number(a.x) || 0)), String(Math.round(Number(a.y) || 0))];
  switch (a.action) {
    case 'screenshot': break;
    case 'move': await xdo(['mousemove', ...xy()]); break;
    case 'click': await xdo(['mousemove', ...xy(), 'click', a.button === 'right' ? '3' : a.button === 'middle' ? '2' : '1']); break;
    case 'double_click': await xdo(['mousemove', ...xy(), 'click', '--repeat', '2', '--delay', '120', '1']); break;
    case 'type': await xdo(['type', '--delay', '12', '--', String(a.text ?? '')]); break;
    case 'key': await xdo(['key', '--', ...String(a.keys ?? '').split(/\s+/).filter(Boolean)]); break;
    case 'scroll': await xdo(['mousemove', ...xy(), 'click', '--repeat', String(Math.min(Number(a.amount) || 3, 20)), a.direction === 'up' ? '4' : '5']); break;
    case 'drag': await xdo(['mousemove', ...xy(), 'mousedown', '1', 'mousemove', String(Math.round(Number(a.x2) || 0)), String(Math.round(Number(a.y2) || 0)), 'mouseup', '1']); break;
    case 'open_url': {
      const url = String(a.url ?? '');
      if (!/^https?:\/\//i.test(url)) return { output: 'open_url needs an http(s) address.', isError: true };
      spawn('sh', ['-c', 'browser "$1" || chromium --no-sandbox "$1" || xdg-open "$1"', 'open', url], { env: displayEnv(), detached: true, stdio: 'ignore' }).unref();
      await new Promise((res) => setTimeout(res, 3000));
      break;
    }
    default: return { output: 'Unknown action. Use screenshot, move, click, double_click, drag, type, key, scroll or open_url.', isError: true };
  }
  if (a.action !== 'screenshot') await new Promise((r) => setTimeout(r, 600));
  const shot = await localScreenshot();
  if (!shot) return { output: a.action === 'screenshot' ? 'No screenshot tool is installed (install scrot or imagemagick).' : 'Done, but no screenshot tool is installed to show the result.', isError: a.action === 'screenshot' };
  return { output: a.action === 'screenshot' ? 'The screen right now.' : 'Done. The screen after the action is attached.', image: { mime: shot.mime, data: shot.data.toString('base64') } };
}

// ---------- the list ----------

export function memoryTool(a: any, ctx: DeviceCtx): DeviceResult {
  const home = ensureHome(ctx.botId);
  const which = a.target === 'user' ? 'user' : 'memory';
  const limit = which === 'user' ? USER_LIMIT : MEMORY_LIMIT;
  const list = entries(readHomeFile(home, which));
  const text = String(a.text ?? '').trim();
  const find = (needle: string) => list.findIndex((e) => e.includes(needle));
  if (a.action === 'add') {
    if (!text) return { output: 'Nothing to remember: text is empty.', isError: true };
    if (list.includes(text)) return { output: 'Already remembered.' };
    list.push(text);
  } else if (a.action === 'replace' || a.action === 'remove') {
    const i = find(String(a.old_text ?? '').trim() || '\u0000');
    if (i < 0) return { output: `No entry contains "${String(a.old_text ?? '').slice(0, 80)}". Current entries:\n${list.map((e) => `- ${e}`).join('\n') || '(none)'}`, isError: true };
    if (a.action === 'remove') list.splice(i, 1);
    else if (!text) return { output: 'replace needs the new text.', isError: true };
    else list[i] = text;
  } else return { output: 'action must be add, replace or remove.', isError: true };
  const next = list.join(SEP);
  if (next.length > limit) return { output: `That would put ${which === 'user' ? 'the notes about the user' : 'your notes'} at ${next.length} characters; the limit is ${limit}. Remove or shorten an entry first:\n${list.slice(0, -1).map((e) => `- ${e}`).join('\n')}`, isError: true };
  writeHomeFile(home, which, next + (list.length ? '\n' : ''));
  hub.emit(ctx.userId, { type: 'memories', botId: ctx.botId });
  return { output: `Saved. ${next.length}/${limit} characters used.`, summary: a.action === 'add' ? 'Remembered' : a.action === 'remove' ? 'Forgot a note' : 'Updated a note' };
}

const BASE: DeviceTool[] = [
  {
    name: 'terminal',
    description: 'Run a shell command on the device you live on and get its output. Runs in your Library folder unless you pass cwd. Use it for anything the other tools do not cover: git, python, node, package managers, curl, file conversion. Long jobs: set background true and check on them later.',
    parameters: obj({
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Working directory. Default: your Library folder.' },
      timeout: { type: 'number', description: 'Seconds before the command is stopped. Default 120, at most 900.' },
      background: { type: 'boolean', description: 'Start it and return at once; output goes to a log file in your Library.' },
    }, ['command']),
    activity: 'running_commands',
    label: 'Running commands',
    gate: shellGate,
    impl: async (a, ctx) => {
      const command = String(a.command ?? '').trim();
      if (!command) return { output: 'No command given.', isError: true };
      const cwd = a.cwd ? resolveIn(ctx.botId, a.cwd) : workspace(ctx.botId);
      if (!fs.existsSync(cwd)) return { output: `No such directory: ${cwd}`, isError: true };
      if (a.background) {
        const log = path.join(workspace(ctx.botId), `job-${Date.now().toString(36)}.log`);
        const fd = fs.openSync(log, 'a');
        const child = spawn(have('bash') ? 'bash' : 'sh', ['-c', command], { cwd, env: shellEnv(), detached: true, stdio: ['ignore', fd, fd] });
        fs.closeSync(fd);
        child.unref();
        return { output: JSON.stringify({ started: true, pid: child.pid, log }), summary: 'Started in the background' };
      }
      const r = await runShell(command, cwd, Math.min(Math.max(Number(a.timeout) || 120, 1), 900), ctx.signal);
      const body = clip(r.output, 30_000) || '(no output)';
      if (r.timedOut) return { output: `${body}\n[stopped: ran past the time limit]`, isError: true, summary: 'Timed out' };
      return { output: r.code === 0 ? body : `${body}\n[exit code ${r.code}]`, isError: r.code !== 0, summary: r.code === 0 ? undefined : `Exit code ${r.code}` };
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file. Paths are relative to your Library folder unless absolute or starting with ~.',
    parameters: obj({ path: { type: 'string' }, offset: { type: 'number', description: 'First line to read (1-based).' }, limit: { type: 'number', description: 'How many lines. Default 400.' } }, ['path']),
    activity: 'working',
    label: 'Reading files',
    impl: async (a, ctx) => {
      const file = resolveIn(ctx.botId, a.path);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { return { output: `No such file: ${file}`, isError: true }; }
      if (st.isDirectory()) return { output: `${file} is a folder. Use list_files.`, isError: true };
      if (st.size > 20 * 1024 * 1024) return { output: `${file} is ${Math.round(st.size / 1e6)} MB; read part of it with the terminal (head, tail, grep).`, isError: true };
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) return { output: `${file} is a binary file (${st.size} bytes).`, isError: true };
      const lines = buf.toString('utf8').split('\n');
      const from = Math.max((Number(a.offset) || 1) - 1, 0);
      const count = Math.min(Number(a.limit) || 400, 2000);
      const part = lines.slice(from, from + count).join('\n');
      return { output: clip(part, 60_000) + (from + count < lines.length ? `\n[lines ${from + 1}-${from + count} of ${lines.length}]` : '') };
    },
  },
  {
    name: 'write_file',
    description: 'Create or replace a text file. Relative paths land in your Library folder, where the user can open and download them.',
    parameters: obj({ path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, ['path', 'content']),
    activity: 'drafting_file',
    label: 'Writing a file',
    impl: async (a, ctx) => {
      const file = resolveIn(ctx.botId, a.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (a.append) fs.appendFileSync(file, String(a.content ?? ''));
      else fs.writeFileSync(file, String(a.content ?? ''));
      return { output: JSON.stringify({ ok: true, path: file, bytes: fs.statSync(file).size }), summary: `Wrote ${path.basename(file)}` };
    },
  },
  {
    name: 'list_files',
    description: 'List a folder. Default: your Library folder.',
    parameters: obj({ path: { type: 'string' } }),
    activity: 'working',
    label: 'Reading files',
    impl: async (a, ctx) => {
      const dir = resolveIn(ctx.botId, a.path ?? '.');
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e: any) { return { output: `Could not list ${dir}: ${e.code ?? e.message}`, isError: true }; }
      const rows = names.slice(0, 500).map((d) => {
        let size = 0;
        try { size = fs.statSync(path.join(dir, d.name)).size; } catch { /* a dangling link */ }
        return d.isDirectory() ? `${d.name}/` : `${d.name}  (${size} bytes)`;
      });
      return { output: `${dir}\n${rows.join('\n') || '(empty)'}${names.length > 500 ? `\n…and ${names.length - 500} more` : ''}` };
    },
  },
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, links and short snippets; open the promising ones with web_fetch.',
    parameters: obj({ query: { type: 'string' }, count: { type: 'number', description: 'How many results, up to 10.' } }, ['query']),
    activity: 'searching_web',
    label: 'Searching the web',
    impl: async (a) => ({ output: await webSearch(String(a.query ?? ''), Math.min(Math.max(Number(a.count) || 6, 1), 10)), summary: 'Searched the web' }),
  },
  {
    name: 'web_fetch',
    description: 'Fetch a web page or API URL and return its text (HTML is reduced to readable text; JSON comes back as it is).',
    parameters: obj({ url: { type: 'string' }, max_chars: { type: 'number', description: 'Default 20000.' } }, ['url']),
    activity: 'reading_web',
    label: 'Reading a page',
    impl: async (a, ctx) => {
      const url = String(a.url ?? '');
      if (!/^https?:\/\//i.test(url)) return { output: 'The URL must start with http:// or https://', isError: true };
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]) });
      const type = r.headers.get('content-type') ?? '';
      if (!/text|json|xml|javascript/.test(type) && type) return { output: `${url} is ${type}, not text. Download it with the terminal (curl -LO) if you need the file.`, isError: true };
      const raw = (await r.text()).slice(0, 3_000_000);
      const text = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
      const max = Math.min(Math.max(Number(a.max_chars) || 20_000, 500), 100_000);
      return { output: `${r.ok ? '' : `[HTTP ${r.status}]\n`}${text.slice(0, max)}${text.length > max ? `\n…(${text.length - max} more characters)` : ''}`, isError: !r.ok };
    },
  },
  {
    name: 'memory',
    description: "Keep durable notes that are shown to you at the start of every conversation. target 'memory' is for your own notes (facts about the work, the environment, what you learned); 'user' is for what you know about the user (preferences, people, how they like things done). Save things that will still matter next week, not the task at hand. To change or drop a note, pass old_text: a short piece of the entry.",
    parameters: obj({ action: { type: 'string', enum: ['add', 'replace', 'remove'] }, target: { type: 'string', enum: ['memory', 'user'] }, text: { type: 'string' }, old_text: { type: 'string' } }, ['action', 'target']),
    activity: 'remembering',
    label: 'Saving notes',
    impl: async (a, ctx) => memoryTool(a, ctx),
  },
];

const PHONE: DeviceTool = {
  name: 'phone',
  description: 'Use the Android phone you run on. Actions: battery, device, wifi, location, notify (title, text), toast (text), vibrate (ms), speak (text, read aloud), clipboard_get, clipboard_set (text), sms_list (limit, number), sms_send (number or contact name, text, sim), call (number or contact name, sim), contacts (query), call_log (limit), photo (front), torch (on), volume (stream, level 0-100), open_url (url), share (text or path), alarm (time like 7:30 or 19:30, label, days like mon,wed), timer (seconds, label), calendar_events (days, query), calendar_add (title, start YYYY-MM-DD HH:MM, end, location, notes), maps (query, mode search or navigate).',
  parameters: obj({
    action: { type: 'string', enum: [...PHONE_ACTIONS] },
    text: { type: 'string' }, title: { type: 'string' }, number: { type: 'string' }, url: { type: 'string' }, path: { type: 'string' },
    query: { type: 'string' }, time: { type: 'string' }, label: { type: 'string' }, days: { type: 'string' }, seconds: { type: 'number' }, sim: { type: 'string' },
    start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, notes: { type: 'string' }, mode: { type: 'string' },
    limit: { type: 'number' }, ms: { type: 'number' }, level: { type: 'number' }, stream: { type: 'string' },
    front: { type: 'boolean' }, on: { type: 'boolean' }, precise: { type: 'boolean' },
  }, ['action']),
  activity: 'on_its_computer',
  label: 'Using the phone',
  gate: (a) =>
    PHONE_OUTWARD.has(a?.action) ? { key: `PHONE_${String(a.action).toUpperCase()}`, title: a.action === 'call' ? `Phone: call ${a.number ?? ''}` : a.action === 'calendar_add' ? `Phone: add "${a.title ?? 'an event'}" to your calendar` : `Phone: text ${a.number ?? ''}` }
    : PHONE_READ_PRIVATE.has(a?.action) ? { key: `PHONE_${String(a.action).toUpperCase()}`, title: `Phone: read your ${String(a.action).replace('_list', '').replace('_events', '').replace('_', ' ')}` }
    : null,
  impl: phone,
};

const SCREEN: DeviceTool = {
  name: 'screen',
  description: 'Your computer screen, which the user can watch live and take over. Actions: screenshot; click, double_click, move (x, y; button left/right/middle); drag (x, y to x2, y2); type (text, into the focused field); key (keys, X11 names such as "ctrl+l" or "Return"); scroll (x, y, direction up/down, amount); open_url (url, opens in your browser on the screen); shell (command, runs on that computer; cloud computer only). Coordinates are pixels of the last screenshot. Every action returns a fresh screenshot. Take a screenshot before your first click.',
  parameters: obj({
    action: { type: 'string', enum: ['screenshot', 'click', 'double_click', 'move', 'drag', 'type', 'key', 'scroll', 'open_url', 'shell'] },
    x2: { type: 'number' }, y2: { type: 'number' }, url: { type: 'string' }, command: { type: 'string' }, timeout: { type: 'number' },
    x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] },
    text: { type: 'string' }, keys: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' },
  }, ['action']),
  activity: 'on_its_computer',
  label: 'Using its computer',
  impl: (a, ctx) => (env.computerMode === 'orgo' ? orgoScreen(a, ctx) : screen(a)),
};

// ---------- device (the YakkBot Android app's bridge) ----------

const DEVICE_ACTIONS = ['read_screen', 'screenshot', 'tap', 'long_press', 'swipe', 'type', 'key', 'open_app', 'list_apps', 'open_url', 'notifications', 'dismiss_notification', 'wait'] as const;
/** Where a screenshot's pixels sit on the real screen, so taps given in screenshot pixels land right. */
let shotScale = 1;

async function device(a: any): Promise<DeviceResult> {
  const n = (v: unknown) => Math.round(Number(v) || 0);
  const k = a.from_screenshot ? shotScale : 1;
  switch (a.action) {
    case 'read_screen': {
      const r = await bridge('/ui/dump', { max: 250 });
      const lines = (r.nodes ?? []).map((x: any) => {
        const flags = [x.tap && 'tap', x.edit && 'edit', x.scroll && 'scroll', x.focused && 'focused', x.checked !== undefined && (x.checked ? 'on' : 'off')].filter(Boolean).join(',');
        return `(${x.x},${x.y}) ${x.kind}${flags ? ` [${flags}]` : ''} ${JSON.stringify(x.text ?? x.label ?? '')}${x.text && x.label ? ` label=${JSON.stringify(x.label)}` : ''}`;
      });
      return { output: `App in front: ${r.app ?? 'unknown'}. Screen ${r.screen?.width}x${r.screen?.height}.\n${lines.join('\n') || '(nothing readable; try a screenshot)'}` };
    }
    case 'screenshot': {
      const r = await bridge('/ui/screenshot', { maxSide: 1280 }, 15_000);
      shotScale = r.screenWidth && r.width ? r.screenWidth / r.width : 1;
      return { output: `Screenshot ${r.width}x${r.height} of a ${r.screenWidth}x${r.screenHeight} screen. To tap something you see in it, pass its pixel position in this image with from_screenshot true.`, image: { mime: r.mime ?? 'image/jpeg', data: r.image } };
    }
    case 'tap':
    case 'long_press': {
      const body = a.text && a.x === undefined ? { text: String(a.text) } : { x: n(a.x * k), y: n(a.y * k) };
      const r = await bridge('/ui/tap', { ...body, long: a.action === 'long_press' });
      return { output: `Tapped (${r.x},${r.y}). Read the screen to see what changed.`, summary: a.text ? `Tapped "${String(a.text).slice(0, 40)}"` : 'Tapped' };
    }
    case 'swipe':
      await bridge('/ui/swipe', { x1: n(a.x * k), y1: n(a.y * k), x2: n(a.x2 * k), y2: n(a.y2 * k), ms: Math.min(Math.max(n(a.ms) || 300, 80), 3000) });
      return { output: 'Swiped.', summary: 'Swiped' };
    case 'type':
      await bridge('/ui/type', { text: String(a.text ?? ''), append: !!a.append, enter: !!a.enter });
      return { output: 'Typed.', summary: 'Typed' };
    case 'key':
      await bridge('/ui/key', { key: String(a.key ?? '') });
      return { output: `Pressed ${a.key}.`, summary: `Pressed ${a.key}` };
    case 'open_app': {
      const r = await bridge('/apps/open', { name: String(a.app ?? a.text ?? '') });
      await new Promise((res) => setTimeout(res, 1200));
      return { output: `Opened ${r.package}. Read the screen next.`, summary: `Opened ${a.app ?? r.package}` };
    }
    case 'list_apps': {
      const r = await bridge('/apps/list');
      return { output: (r.apps ?? []).map((x: any) => `${x.name} (${x.package})`).sort().join('\n') };
    }
    case 'open_url':
      await bridge('/open', { url: String(a.url ?? '') });
      return { output: 'Opened.', summary: 'Opened a link' };
    case 'notifications': {
      const r = await bridge('/notifications/list', { limit: Math.min(n(a.limit) || 30, 100) });
      return { output: JSON.stringify(r.notifications ?? [], null, 1).slice(0, 30_000) };
    }
    case 'dismiss_notification':
      await bridge('/notifications/dismiss', { key: String(a.key ?? '') });
      return { output: 'Dismissed.' };
    case 'wait':
      await new Promise((res) => setTimeout(res, Math.min(Math.max(n(a.ms) || 1000, 100), 10_000)));
      return { output: 'Waited.' };
    default:
      return { output: `Unknown action "${a.action}". Use one of: ${DEVICE_ACTIONS.join(', ')}.`, isError: true };
  }
}

const DEVICE: DeviceTool = {
  name: 'device',
  description: 'Operate the Android phone itself, in any app, the way a person would. Actions: read_screen (the text and buttons on screen with their positions; start here), screenshot (an image, when the text is not enough), tap / long_press (x, y, or text to tap the first element containing it), swipe (x, y to x2, y2; swipe up to scroll down), type (text into the focused field; append, enter), key (back, home, recents, notifications, quick_settings, lock), open_app (app name or package), list_apps, open_url (a link, tel:, geo:, or an android.settings.* page), notifications (limit), dismiss_notification (key), wait (ms). Positions are real screen pixels unless from_screenshot is true. After each action, read the screen again before the next one. Stop and tell the user if you reach a payment, a password prompt or anything you were not asked to do.',
  parameters: obj({
    action: { type: 'string', enum: [...DEVICE_ACTIONS] },
    x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
    text: { type: 'string' }, app: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
    append: { type: 'boolean' }, enter: { type: 'boolean' }, from_screenshot: { type: 'boolean' },
    ms: { type: 'number' }, limit: { type: 'number' },
  }, ['action']),
  activity: 'on_its_computer',
  label: 'Using the phone',
  // One OK covers a kind of access; "Always allow" on the card remembers it.
  gate: (a) =>
    a?.action === 'notifications' || a?.action === 'dismiss_notification' ? { key: 'DEVICE_READ_NOTIFICATIONS', title: 'Phone: read your notifications' }
    : a?.action === 'list_apps' || a?.action === 'wait' ? null
    : a?.action === 'read_screen' || a?.action === 'screenshot' ? { key: 'DEVICE_SEE_THE_SCREEN', title: 'Phone: see what is on your screen' }
    : { key: 'DEVICE_CONTROL_THE_SCREEN', title: 'Phone: tap and type on your screen' },
  impl: (a) => device(a),
};

export const deviceBridgeAvailable = () => bridgeUsable();
export const phoneAvailable = () => (env.isTermux && have('termux-battery-status')) || bridgePhone();
export const screenAvailable = () => env.computerMode === 'orgo' || (hasLocalDesktop() && have('xdotool'));

export function deviceTools(): DeviceTool[] {
  return [...BASE, ...(phoneAvailable() ? [PHONE] : []), ...(deviceBridgeAvailable() ? [DEVICE] : []), ...(screenAvailable() ? [SCREEN] : [])];
}

/** Every device tool there is, for labels and activity lines (whether or not this device offers it). */
export const ALL_DEVICE_TOOLS: DeviceTool[] = [...BASE, PHONE, DEVICE, SCREEN];

export const policyMode = (userId: string, key: string): string | undefined => (db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, key) as any)?.mode;
