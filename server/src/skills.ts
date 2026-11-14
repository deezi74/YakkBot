import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';

/** A bot's skills: reusable know-how for a kind of task, written by the user or learned by the bot itself. */
export interface SkillRow { id: string; name: string; description: string; body: string }

export const listSkills = (botId: string): SkillRow[] =>
  db.prepare('SELECT id, name, description, body FROM skills WHERE bot_id=? ORDER BY created_at').all(botId) as any[];

export function findSkill(botId: string, name: string): SkillRow | undefined {
  return listSkills(botId).find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
}

/** Creates the skill, or rewrites the one with the same name. Returns whether it was new. */
export function saveSkill(userId: string, botId: string, s: { name: string; description?: string; body: string }): boolean {
  const name = s.name.trim().slice(0, 80);
  const body = s.body.trim().slice(0, 8000);
  const description = (s.description ?? '').trim().slice(0, 300);
  if (!name || !body) throw new Error('A skill needs a name and its steps.');
  const old = findSkill(botId, name);
  if (old) db.prepare('UPDATE skills SET body=?, description=?, updated_at=? WHERE id=?').run(body, description || old.description, now(), old.id);
  else db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(newId('skill'), botId, name, body, description, now(), now());
  hub.emit(userId, { type: 'skills', botId } as any);
  return !old;
}

export function deleteSkill(userId: string, botId: string, name: string): boolean {
  const old = findSkill(botId, name);
  if (!old) return false;
  db.prepare('DELETE FROM skills WHERE id=?').run(old.id);
  hub.emit(userId, { type: 'skills', botId } as any);
  return true;
}

/**
 * The skills part of the system prompt. Short collections go in whole; longer ones are listed by name
 * and description so the prompt stays small (faster replies, above all for models on the phone), and
 * the bot opens one with the skill tool when a task calls for it.
 */
export function skillsBlock(botId: string): string {
  const all = listSkills(botId);
  if (!all.length) return '';
  const full = all.map((s) => `### ${s.name}\n${s.body}`).join('\n\n');
  if (full.length <= 3000) return full;
  return `${all.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')}\n\nOpen one with the skill tool (action view) before a task it covers.`;
}
