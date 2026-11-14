import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Small helper programs YakkBot can install and keep running next to itself, the same ones D-Agent
 * starts in Termux, on the same ports, so one copy serves both apps:
 *  - the free natural voice: an OpenAI-style /v1/audio/speech server backed by edge-tts (port 5050)
 *  - FreeLLMAPI: one OpenAI-style endpoint over many free AI tiers (port 3001, ~/freellmapi)
 * They run wherever this server runs: Termux, a Linux PC, or the app's built-in Linux.
 */
export const FREE_VOICE_PORT = Number(process.env.YAKK_FREE_VOICE_PORT ?? 5050);
export const FREELLMAPI_PORT = Number(process.env.YAKK_FREELLMAPI_PORT ?? 3001);
const HOME = os.homedir();
export const VOICE_DIR = path.join(HOME, '.yakkbot', 'voice');
export const FREELLMAPI_DIR = path.join(HOME, 'freellmapi');

/** The voice server: POST /v1/audio/speech {input, voice, speed} returns MP3. GET /health answers ok. */
export const VOICE_SERVER_PY = `import asyncio, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import edge_tts

async def speak(text, voice, rate):
    out = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
        if chunk["type"] == "audio":
            out += chunk["data"]
    return bytes(out)

def rate_of(speed):
    try:
        pct = round((float(speed) - 1.0) * 100)
    except Exception:
        pct = 0
    pct = max(-50, min(100, pct))
    return ("+" if pct >= 0 else "") + str(pct) + "%"

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.startswith("/v1/audio/speech"):
            self.send_error(404); return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        try:
            audio = asyncio.run(speak(body.get("input", ""), body.get("voice") or "en-US-AvaNeural", rate_of(body.get("speed", 1))))
        except Exception as e:
            msg = json.dumps({"error": {"message": str(e)}}).encode()
            self.send_response(500); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(msg); return
        self.send_response(200); self.send_header("Content-Type", "audio/mpeg"); self.send_header("Content-Length", str(len(audio))); self.end_headers()
        self.wfile.write(audio)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"voice is running")
    def log_message(self, *a): pass

print("Free voice running on http://127.0.0.1:${FREE_VOICE_PORT}")
ThreadingHTTPServer(("127.0.0.1", ${FREE_VOICE_PORT}), Handler).serve_forever()
`;

export async function portOpen(port: number, ms = 1500): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(ms) }); return true; } catch { return false; }
}

/** Installs the package a command needs with whichever package manager this system has. */
export const pkgInstall = (termuxPkgs: string, alpinePkgs: string, debianPkgs: string) =>
  `if command -v pkg >/dev/null && [ -n "$PREFIX" ]; then pkg install -y ${termuxPkgs}; ` +
  `elif command -v apk >/dev/null; then apk add --no-cache ${alpinePkgs}; ` +
  `elif command -v apt-get >/dev/null; then (apt-get update && apt-get install -y ${debianPkgs}) || sudo -n apt-get install -y ${debianPkgs}; ` +
  `elif command -v brew >/dev/null; then brew install ${debianPkgs.split(' ')[0]}; fi`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One-time install, then start, of the free voice. */
export function voiceSetupScript(): string {
  const b64 = Buffer.from(VOICE_SERVER_PY).toString('base64');
  return [
    `mkdir -p ${quote(VOICE_DIR)} && echo ${b64} | base64 -d > ${quote(path.join(VOICE_DIR, 'server.py'))}`,
    `command -v python3 >/dev/null || command -v python >/dev/null || { ${pkgInstall('python', 'python3 py3-pip', 'python3 python3-pip')}; }`,
    `PY=$(command -v python3 || command -v python)`,
    // Pure-Python builds of edge-tts's helpers avoid compiling C on a phone.
    `$PY -c 'import edge_tts' 2>/dev/null || { export AIOHTTP_NO_EXTENSIONS=1 MULTIDICT_NO_EXTENSIONS=1 YARL_NO_EXTENSIONS=1 FROZENLIST_NO_EXTENSIONS=1 PROPCACHE_NO_EXTENSIONS=1; ` +
      `$PY -m pip install --user edge-tts 2>/dev/null || $PY -m pip install --break-system-packages edge-tts || $PY -m pip install edge-tts; }`,
    `$PY -c 'import edge_tts' && echo "edge-tts is installed."`,
  ].join('\n');
}

/** FreeLLMAPI: clone once into ~/freellmapi and install its packages. */
export function freellmapiSetupScript(): string {
  return [
    `command -v git >/dev/null || { ${pkgInstall('git', 'git', 'git')}; }`,
    `command -v npm >/dev/null || { ${pkgInstall('nodejs', 'nodejs npm', 'nodejs npm')}; }`,
    `[ -d ${quote(FREELLMAPI_DIR)}/.git ] || git clone --depth 1 https://github.com/tashfeenahmed/freellmapi ${quote(FREELLMAPI_DIR)}`,
    `cd ${quote(FREELLMAPI_DIR)} && git pull --ff-only || true`,
    `cd ${quote(FREELLMAPI_DIR)} && npm install`,
    `echo "FreeLLMAPI is installed."`,
  ].join('\n');
}

export const voiceInstalled = () => fs.existsSync(path.join(VOICE_DIR, 'server.py'));
export const freellmapiInstalled = () => fs.existsSync(path.join(FREELLMAPI_DIR, 'node_modules'));

const running = new Map<string, ReturnType<typeof spawn>>();

/** Starts a helper in the background (once), logging next to it. It keeps running if YakkBot restarts. */
export async function startService(name: 'voice' | 'freellmapi'): Promise<{ ok: boolean; message: string }> {
  const port = name === 'voice' ? FREE_VOICE_PORT : FREELLMAPI_PORT;
  if (await portOpen(port)) return { ok: true, message: 'Already running.' };
  if (name === 'voice' && !voiceInstalled()) return { ok: false, message: 'Set up the free voice first.' };
  if (name === 'freellmapi' && !fs.existsSync(FREELLMAPI_DIR)) return { ok: false, message: 'Set up FreeLLMAPI first.' };
  const prev = running.get(name);
  if (prev && prev.exitCode === null) return { ok: true, message: 'Starting…' };
  const log = fs.openSync(path.join(name === 'voice' ? VOICE_DIR : FREELLMAPI_DIR, name === 'voice' ? 'server.log' : 'yakkbot.log'), 'a');
  const cmd = name === 'voice'
    ? `exec "$(command -v python3 || command -v python)" ${quote(path.join(VOICE_DIR, 'server.py'))}`
    : `cd ${quote(FREELLMAPI_DIR)} && ([ -d node_modules ] || npm install) && exec npm run dev`;
  const child = spawn('sh', ['-c', `command -v termux-wake-lock >/dev/null && termux-wake-lock; ${cmd}`], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  running.set(name, child);
  for (let i = 0; i < (name === 'voice' ? 20 : 60); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await portOpen(port)) return { ok: true, message: 'Running.' };
    if (child.exitCode !== null) break;
  }
  return { ok: false, message: `It did not start. See the log in ${name === 'voice' ? VOICE_DIR : FREELLMAPI_DIR}.` };
}

/** At YakkBot start: bring back the helpers that were set up. */
export function autostartServices(want: { voice?: boolean; freellmapi?: boolean }) {
  if (want.voice && voiceInstalled()) void startService('voice').catch(() => {});
  if (want.freellmapi && freellmapiInstalled()) void startService('freellmapi').catch(() => {});
}
