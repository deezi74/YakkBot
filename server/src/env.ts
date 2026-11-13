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
const hermesHome = str('HERMES_HOME_PRIMARY', path.join(os.homedir(), '.hermes'));
const orgoComputerId = str('ORGO_COMPUTER_ID');
const vncPort = Number(str('VNC_PORT', '0'));

export type ComputerMode = 'none' | 'local' | 'orgo';
const computerMode: ComputerMode = ((): ComputerMode => {
  const v = str('YAKK_COMPUTER').toLowerCase();
  if (v === 'none' || v === 'local' || v === 'orgo') return v;
  if (orgoComputerId) return 'orgo';
  return vncPort ? 'local' : 'none';
})();

export const env = {
  port,
  /** 127.0.0.1 keeps the app on this device; 0.0.0.0 opens it to the local network. */
  host: str('HOST', '127.0.0.1'),
  dataDir,
  isTermux,
  appUrl: str('APP_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: str('SERVER_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  sessionSecret: sessionSecret(),
  dbPath: str('DB_PATH', path.join(dataDir, 'yakkbot.db')),
  /** Where each bot's Library (the files it makes for you) lives: <root>/<botId>/. */
  libraryRoot: path.resolve(str('LIBRARY_ROOT', computerMode === 'orgo' ? '/root/yakkbot/files' : path.join(dataDir, 'files'))),

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
  maxBots: Number(str('MAX_BOTS', orgoComputerId ? '4' : '12')),

  // ---- the bots' computer ----
  computerMode,
  /** local mode: a VNC server on this device (Termux XFCE, x11vnc, TigerVNC). */
  vncHost: str('VNC_HOST', '127.0.0.1'),
  vncPort,
  vncPassword: secret('VNC_PASSWORD'),
  /** local mode: the X display the bots act on (screenshots, xdotool). */
  display: str('YAKK_DISPLAY', vncPort >= 5900 && vncPort < 6000 ? `:${vncPort - 5900}` : ':0'),
  orgoKey: secret('ORGO_API_KEY'),
  orgoComputerId,
  /** orgo mode: this server runs on that computer, so shell commands run locally. */
  localBox: computerMode === 'orgo' ? flag('HQ_LOCAL') : true,
  primaryCdpUrl: str('PRIMARY_CDP_URL'),

  // ---- add-ons ----
  composioKey: secret('COMPOSIO_API_KEY'),
  xaiKey: secret('XAI_API_KEY'),
  xaiModel: str('XAI_MODEL', 'grok-4.7'),
  telegramToken: secret('TELEGRAM_BOT_TOKEN'),
  /** Telegram chat ids allowed to talk to the bots. Empty = nobody (the bridge prints ids that try). */
  telegramChats: str('TELEGRAM_ALLOWED_CHATS').split(',').map((s) => s.trim()).filter(Boolean),
};

if (env.computerMode !== 'orgo') fs.mkdirSync(env.libraryRoot, { recursive: true });

export const features = () => ({
  engine: env.engine,
  computer: env.computerMode,
  apps: !!env.composioKey,
  xSearch: !!env.xaiKey,
  voice: !!env.xaiKey,
  googleLogin: !!env.composioKey,
  passwordLogin: !!env.password,
  devLogin: env.devLogin,
  phone: env.isTermux,
  telegram: !!env.telegramToken,
});
export type Features = ReturnType<typeof features>;
