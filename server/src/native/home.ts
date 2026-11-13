import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';

/**
 * A native bot's home: <ENGINES_DIR>/<botId>/ with the same layout Hermes uses, so the memory panel
 * and the files a person can edit are the same for both engines.
 *
 *   SOUL.md              who the bot is (persona, voice). Editable in the app.
 *   memories/MEMORY.md   the bot's own notes, entries separated by a line holding "§"
 *   memories/USER.md     what it knows about its owner
 */

export const SEP = '\n§\n';
export const MEMORY_LIMIT = 6000;
export const USER_LIMIT = 3000;

export const nativeHome = (botId: string) => path.join(env.enginesDir, botId);

/** A new bot's persona. Its name, role and description come from the app, so the soul is only its character. */
export function defaultSoul(): string {
  return [
    '# Soul',
    '',
    'You are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    '',
    'You have opinions and share them when asked. You would rather ask one good question than guess wrong on something that matters, and rather make a sensible call than ask about something that does not.',
    '',
  ].join('\n');
}

export function ensureHome(botId: string): string {
  const home = nativeHome(botId);
  fs.mkdirSync(path.join(home, 'memories'), { recursive: true, mode: 0o700 });
  const soul = path.join(home, 'SOUL.md');
  if (!fs.existsSync(soul)) fs.writeFileSync(soul, defaultSoul(), { mode: 0o600 });
  return home;
}

export type HomeFile = 'soul' | 'memory' | 'user';
const FILES: Record<HomeFile, string> = { soul: 'SOUL.md', memory: 'memories/MEMORY.md', user: 'memories/USER.md' };
export const homeFilePath = (home: string, which: HomeFile) => path.join(home, FILES[which]);

export function readHomeFile(home: string, which: HomeFile): string {
  try { return fs.readFileSync(homeFilePath(home, which), 'utf8'); } catch { return ''; }
}

export function writeHomeFile(home: string, which: HomeFile, text: string) {
  const file = homeFilePath(home, which);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'), { mode: 0o600 });
}

export const entries = (raw: string) => raw.split(SEP).map((e) => e.trim()).filter(Boolean);

/** The memory section of the system prompt, as it stands right now. */
export function memoryBlock(home: string): string {
  const mem = entries(readHomeFile(home, 'memory'));
  const user = entries(readHomeFile(home, 'user'));
  const list = (xs: string[]) => (xs.length ? xs.map((e) => `- ${e.replace(/\n/g, '\n  ')}`).join('\n') : '(nothing yet)');
  return `## What you remember\nThese notes are yours. They were loaded when this conversation started; change them with the memory tool.\n\n### Your notes\n${list(mem)}\n\n### About the user\n${list(user)}`;
}
