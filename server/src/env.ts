import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Settings. Everything has a default that works on a phone: the only thing YakkBot needs to answer a
 * message is one model key. Hermes, Orgo, Composio and xAI are add-ons that switch on when configured.
 *
 * Values come from the process environment, then from <YAKK_HOME>/.env (written by the installer).
 */

export const dataDir = path.resolve(process.env.YAKK_HOME ?? path.join(os.homedir(), '.yakkbot'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
export function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

export const envFile = process.env.YAKK_ENV_FILE ?? path.join(dataDir, '.env');
for (const [k, v] of Object.entries(readDotenv(envFile))) if (process.env[k] === undefined) process.env[k] = v;

const str = (name: string, fallback = '') => process.env[name] ?? fallback;
const flag = (name: string, fallback = false) => (process.env[name] === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(process.env[name]!.toLowerCase()));

/** A secret from NAME, or from the file named by NAME_FILE. Empty when neither is set. */
function secret(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = process.env[`${name}_FILE`];
  if (file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* unreadable: treated as unset */ } }
  return '';
}

/** Signs sessions and the agents' MCP tokens. Generated once and kept beside the database. */
function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session.secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const s = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const port = Number(str('PORT', '8787'));
const isTermux = !!process.env.TERMUX_VERSION || (process.env.PREFIX ?? '').includes('com.termux');
/** Running inside the YakkBot Android app's own Linux. */
const inApp = process.env.YAKK_PLATFORM === 'android-app';
const hermesHome = str('HERMES_HOME_PRIMARY', path.join(os.homedir(), '.hermes'));
const vncPort = Number(str('VNC_PORT', '0'));

// ---------- settings made in the app (Settings > Computer) ----------
// Kept in <YAKK_HOME>/settings.json (mode 600) so they apply without editing .env or restarting.

interface AppSettings { computer?: 'none' | 'local' | 'orgo'; orgoKey?: string; orgoComputerId?: string; orgoComputerName?: string }
const settingsFile = path.join(dataDir, 'settings.json');
let appSettings: AppSettings = {};
try { appSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* none yet */ }

export function getAppSettings(): AppSettings { return { ...appSettings }; }
export function setAppSettings(patch: AppSettings) {
  appSettings = { ...appSettings, ...patch };
  for (const k of Object.keys(appSettings) as (keyof AppSettings)[]) if (appSettings[k] === undefined || appSettings[k] === '') delete appSettings[k];
  fs.writeFileSync(settingsFile, JSON.stringify(appSettings, null, 2), { mode: 0o600 });
  fs.chmodSync(settingsFile, 0o600);
}

const orgoComputerIdEnv = str('ORGO_COMPUTER_ID');

export type ComputerMode = 'none' | 'local' | 'orgo';
/** Which computer the bots use. A choice made in the app wins over the environment. */
function computerMode(): ComputerMode {
  const chosen = appSettings.computer;
  if (chosen === 'orgo' && appSettings.orgoKey && appSettings.orgoComputerId) return 'orgo';
  if (chosen === 'none') return 'none';
  if (chosen === 'local' && vncPort) return 'local';
  const v = str('YAKK_COMPUTER').toLowerCase();
  if (v === 'none' || v === 'local' || v === 'orgo') return v;
  if (orgoComputerIdEnv) return 'orgo';
  return vncPort ? 'local' : 'none';
}
const serverOnOrgo = flag('HQ_LOCAL') && !!orgoComputerIdEnv;

export const env = {
  port,
  /** 127.0.0.1 keeps the app on this device; 0.0.0.0 opens it to the local network. */
  host: str('HOST', '127.0.0.1'),
  dataDir,
  isTermux,
  inApp,
  appUrl: str('APP_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: str('SERVER_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  sessionSecret: sessionSecret(),
  dbPath: str('DB_PATH', path.join(dataDir, 'yakkbot.db')),
  /** Where each bot's Library (the files it makes for you) lives: <root>/<botId>/. */
  libraryRoot: path.resolve(str('LIBRARY_ROOT', serverOnOrgo ? '/root/yakkbot/files' : path.join(dataDir, 'files'))),

  // ---- sign-in ----
  /** Owner name and passphrase for the single-owner sign-in. An empty passphrase disables it. */
  ownerName: str('YAKK_OWNER', 'Owner'),
  ownerEmail: str('YAKK_OWNER_EMAIL', 'owner@yakkbot.local'),
  password: secret('YAKK_PASSWORD'),
  /** Email-only sign-in for development. Never on a reachable address. */
  devLogin: flag('DEV_LOGIN'),
  /** Comma-separated emails allowed to sign in with Google; empty = anyone who can reach the app. */
  allowedEmails: str('ALLOWED_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // ---- engines ----
  /** 'native' = YakkBot's own agent loop (any model key). 'hermes' = Hermes Agent gateways. */
  engine: (str('YAKK_ENGINE', 'native').toLowerCase() === 'hermes' ? 'hermes' : 'native') as 'native' | 'hermes',
  /** Ask before a shell command runs: 'risky' (default) asks for destructive or outward-facing ones, 'always', or 'off'. */
  shellApproval: (['off', 'risky', 'always'].includes(str('YAKK_SHELL_APPROVAL', 'risky')) ? str('YAKK_SHELL_APPROVAL', 'risky') : 'risky') as 'off' | 'risky' | 'always',
  /** History size (characters) at which a native conversation is summarised and started over. */
  contextChars: Number(str('YAKK_CONTEXT_CHARS', '400000')),
  maxSteps: Number(str('YAKK_MAX_STEPS', '60')),
  hermesBin: str('HERMES_BIN', 'hermes'),
  hermesHome,
  hermesUrl: str('HERMES_URL', 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: str('HERMES_KEY'),
  enginesDir: path.resolve(str('ENGINES_DIR', path.join(dataDir, 'engines'))),
  enginePortBase: Number(str('ENGINE_PORT_BASE', '8650')),
  /** URL the Hermes gateways (or any MCP client) use to reach this server's MCP endpoint. */
  mcpBaseUrl: str('MCP_BASE_URL', `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
  extraMcpServers: str('EXTRA_MCP_SERVERS'),
  primaryBotName: str('PRIMARY_BOT_NAME', 'Yakk'),
  primaryBotLabel: str('PRIMARY_BOT_LABEL', 'Chief of Staff'),
  /** On an Orgo computer every bot has a screen of its own, and Orgo allows 4 screens per computer. */
  get maxBots() { return Number(process.env.MAX_BOTS ?? (computerMode() === 'orgo' ? 4 : 12)); },

  // ---- the bots' computer ----
  get computerMode() { return computerMode(); },
  /** local mode: a VNC server on this device (Termux XFCE, x11vnc, TigerVNC). */
  vncHost: str('VNC_HOST', '127.0.0.1'),
  vncPort,
  vncPassword: secret('VNC_PASSWORD'),
  /** local mode: the X display the bots act on (screenshots, xdotool). */
  display: str('YAKK_DISPLAY', vncPort >= 5900 && vncPort < 6000 ? `:${vncPort - 5900}` : ':0'),
  get orgoKey() { return appSettings.orgoKey || secret('ORGO_API_KEY'); },
  get orgoComputerId() { return computerMode() === 'orgo' ? appSettings.orgoComputerId || orgoComputerIdEnv : ''; },
  /** orgo mode: this server runs on that computer, so shell commands run locally. */
  /** Commands for the bots' computer run on this machine (the server runs on it), not through Orgo's API. */
  get localBox() { return computerMode() === 'orgo' ? serverOnOrgo : true; },
  primaryCdpUrl: str('PRIMARY_CDP_URL'),

  // ---- add-ons ----
  composioKey: secret('COMPOSIO_API_KEY'),
  xaiKey: secret('XAI_API_KEY'),
  xaiModel: str('XAI_MODEL', 'grok-4.7'),
  telegramToken: secret('TELEGRAM_BOT_TOKEN'),
  /** Telegram chat ids allowed to talk to the bots. Empty = nobody (the bridge prints ids that try). */
  telegramChats: str('TELEGRAM_ALLOWED_CHATS').split(',').map((s) => s.trim()).filter(Boolean),
};

if (!serverOnOrgo) fs.mkdirSync(env.libraryRoot, { recursive: true });

export const features = () => ({
  engine: env.engine,
  computer: env.computerMode,
  apps: !!env.composioKey,
  xSearch: !!env.xaiKey,
  voice: !!env.xaiKey,
  googleLogin: !!env.composioKey,
  passwordLogin: !!env.password,
  devLogin: env.devLogin,
  phone: env.isTermux || env.inApp,
  app: env.inApp,
  /** The On-device models page: the app's engine, or llama-server on this machine. */
  models: true,
  telegram: !!env.telegramToken,
});
// (Whether the Android app is paired is live state, served by GET /api/device.)
export type Features = ReturnType<typeof features>;
