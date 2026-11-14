import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import * as orgoComputer from './computer-orgo.js';
import type { ComputerState } from './types.js';

/**
 * The bots' computer, in one of three forms (YAKK_COMPUTER):
 *
 *  - none   No screen. A bot's "computer" is the device the server runs on: its shell, its files and,
 *           on a phone, the Termux:API bridge. This is the phone default.
 *  - local  One desktop on this device, reached over VNC (Termux XFCE, x11vnc, TigerVNC). Every bot
 *           shares it; the app shows it live and can take control.
 *  - orgo   One Orgo cloud computer with a screen per bot (the original Bot HQ arrangement).
 */

export type { BotScreen } from './computer-orgo.js';
import type { BotScreen } from './computer-orgo.js';

const LOCAL_SCREEN = 'default';

const agentBots = (userId: string) => (db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").all(userId) as any[]).map((b) => b.id as string);

// ---------- local desktop ----------

let localUp: { at: number; ok: boolean } = { at: 0, ok: false };
let localSize: { width: number; height: number } | null = null;

function probeVnc(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: env.vncHost, port: env.vncPort });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function localAlive(): Promise<boolean> {
  if (Date.now() - localUp.at < 5000) return localUp.ok;
  localUp = { at: Date.now(), ok: await probeVnc() };
  return localUp.ok;
}

/** The VNC server reported its size during a viewer handshake (see vnc.ts). */
export function noteLocalScreenSize(width: number, height: number) {
  if (width > 0 && height > 0) localSize = { width, height };
}

function localState(userId: string): ComputerState {
  const ok = localUp.ok;
  return {
    status: ok ? 'running' : 'stopped',
    orgoId: null,
    error: ok ? null : `No desktop is answering on ${env.vncHost}:${env.vncPort}. Start your VNC server (on a phone: yakkbot desktop start).`,
    screens: ok ? agentBots(userId).map((botId) => ({ botId, screenId: LOCAL_SCREEN, ...(localSize ?? {}) })) : [],
    maxScreens: env.maxBots,
  };
}

const run = (file: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ ok: boolean; stdout: Buffer; stderr: string }>((resolve) => {
    execFile(file, args, { timeout: opts.timeout ?? 15_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', env: opts.env ?? process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout as Buffer, stderr: String(stderr ?? '') });
    });
  });

/** Environment for anything that acts on the local desktop. */
export const displayEnv = (): NodeJS.ProcessEnv => ({ ...process.env, DISPLAY: env.display });

let shotTool: string | null | undefined;

/** A JPEG (or PNG) of the local desktop, or null when no screenshot tool is installed. */
export async function localScreenshot(): Promise<{ data: Buffer; mime: string } | null> {
  const tmp = path.join(os.tmpdir(), `yakk-shot-${process.pid}.jpg`);
  const attempts: [string, string[]][] = [
    ['scrot', ['-o', '-q', '70', tmp]],
    ['import', ['-window', 'root', '-quality', '70', tmp]],
    ['xfce4-screenshooter', ['-f', '-s', tmp]],
    ['gnome-screenshot', ['-f', tmp]],
  ];
  const order = shotTool ? attempts.filter(([t]) => t === shotTool) : shotTool === null ? [] : attempts;
  for (const [tool, args] of order) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* fine */ }
    const r = await run(tool, args, { env: displayEnv() });
    if (r.ok && fs.existsSync(tmp)) {
      shotTool = tool;
      const data = fs.readFileSync(tmp);
      fs.rmSync(tmp, { force: true });
      return { data, mime: 'image/jpeg' };
    }
  }
  if (shotTool === undefined) shotTool = null;
  return null;
}

// ---------- the facade ----------

export function computerState(userId: string): ComputerState {
  if (env.computerMode === 'orgo') return orgoComputer.computerState(userId);
  if (env.computerMode === 'local') return localState(userId);
  return { status: 'absent', orgoId: null, error: null, screens: [], maxScreens: 0 };
}

export async function refreshComputer(userId: string): Promise<ComputerState> {
  if (env.computerMode === 'orgo') return orgoComputer.refreshComputer(userId);
  if (env.computerMode === 'local') { localUp.at = 0; await localAlive(); }
  return computerState(userId);
}

export async function ensureComputer(userId: string): Promise<string> {
  if (env.computerMode === 'orgo') return orgoComputer.ensureComputer(userId);
  if (env.computerMode === 'local') {
    const was = localUp.ok;
    localUp.at = 0;
    if ((await localAlive()) !== was) hub.emit(userId, { type: 'computer', state: computerState(userId) });
    if (!localUp.ok) throw new Error(localState(userId).error ?? 'The desktop is not running.');
    return 'local';
  }
  throw new Error('This install has no desktop for the bots. They work through the shell and files instead.');
}

export async function screenFor(userId: string, botId: string): Promise<BotScreen> {
  if (env.computerMode === 'orgo') return orgoComputer.screenFor(userId, botId);
  await ensureComputer(userId);
  return { computerId: 'local', screenId: LOCAL_SCREEN, ...(localSize ?? {}) };
}

export async function readyScreen(userId: string, botId: string, opts: { redress?: boolean } = {}): Promise<BotScreen> {
  if (env.computerMode === 'orgo') return orgoComputer.readyScreen(userId, botId, opts);
  return screenFor(userId, botId);
}

export function cdpUrlFor(botId: string, screenId: string): string {
  return env.computerMode === 'orgo' ? orgoComputer.cdpUrlFor(botId, screenId) : '';
}

export async function screenForWork(userId: string, botId: string): Promise<void> {
  if (env.computerMode === 'orgo') return orgoComputer.screenForWork(userId, botId);
}

export async function resetBotScreen(userId: string, botId: string): Promise<void> {
  if (env.computerMode === 'orgo') return orgoComputer.resetBotScreen(userId, botId);
  throw new Error('Resetting the screen is only available with an Orgo computer.');
}

export async function releaseScreen(botId: string): Promise<void> {
  if (env.computerMode === 'orgo') return orgoComputer.releaseScreen(botId);
}

/** A deleted bot leaves nothing behind: its Library folder (and, on Orgo, its browser profile) go. */
export async function forgetBotFiles(botId: string): Promise<void> {
  if (!/^(bot|sub)_[\w-]+$/.test(botId)) return;
  if (env.computerMode === 'orgo') return orgoComputer.forgetBotFiles(botId);
  const dir = path.join(env.libraryRoot, botId);
  if (path.resolve(dir).startsWith(path.resolve(env.libraryRoot) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

export async function suspendComputer(_userId: string, _reason = 'manual'): Promise<void> {}

/** Whether the bots can see and drive a desktop from here (local mode on this device). */
export const hasLocalDesktop = () => env.computerMode === 'local';
export const localDesktopAlive = localAlive;
