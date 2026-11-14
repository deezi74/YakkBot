import { getAppSettings } from '../env.js';
import { appendRow } from '../store.js';
import { listSkills, saveSkill } from '../skills.js';
import { entries, readHomeFile, ensureHome } from './home.js';
import { callModel, type Item } from './llm.js';
import { memoryTool } from './tools.js';

/**
 * Getting better on its own: after a turn worth learning from, the bot looks back over it with a
 * short, separate model call and keeps what will help next time: facts about the user, notes about
 * the work, and a skill for a task it may repeat (or a better version of one it has). It runs in
 * the background after the reply is sent, so it never slows the reply down.
 */

// Words that usually mean the user is teaching the bot something.
const TEACHING = /\b(remember|always|never|from now on|i prefer|i like|i don'?t like|i hate|call me|my name|instead|that'?s wrong|not like that|next time|don'?t do)\b/i;

const busy = new Set<string>();

export function shouldLearn(o: { userText: string; toolRounds: number; userTurns: number }): boolean {
  if (getAppSettings().autoLearn === false) return false;
  return o.toolRounds >= 3 || TEACHING.test(o.userText) || (o.userTurns > 0 && o.userTurns % 6 === 0);
}

function transcript(items: Item[]): string {
  return items.map((it) => {
    if (it.role === 'user') return `USER: ${it.text}`;
    if (it.role === 'assistant') return `YOU: ${it.text}${it.calls.length ? `\n[you called ${it.calls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 200)})`).join(', ')}]` : ''}`;
    return `RESULT of ${it.name}${it.isError ? ' (error)' : ''}: ${it.output.slice(0, 800)}`;
  }).join('\n\n').slice(-24_000);
}

export function learnInBackground(o: { userId: string; botId: string; provider: string; model: string; turn: Item[] }) {
  if (busy.has(o.botId)) return;
  busy.add(o.botId);
  void learn(o).catch((e) => console.warn('[learn]', e?.message ?? e)).finally(() => busy.delete(o.botId));
}

async function learn(o: { userId: string; botId: string; provider: string; model: string; turn: Item[] }) {
  const home = ensureHome(o.botId);
  const notes = entries(readHomeFile(home, 'memory'));
  const about = entries(readHomeFile(home, 'user'));
  const skills = listSkills(o.botId);
  const skillText = skills.map((s) => `### ${s.name}${s.description ? ` (${s.description})` : ''}\n${s.body}`).join('\n\n').slice(0, 8000);
  const reply = await callModel({
    provider: o.provider, model: o.model, effort: 'low', keepThinking: false, tools: [], onDelta: () => {},
    signal: AbortSignal.timeout(180_000),
    system: [
      'You are reviewing a piece of your own recent work to get better at helping this user. Decide what is worth keeping for the future.',
      'Reply with JSON only, no other text, in this shape:',
      '{"user": ["short fact about the user"], "memory": ["short note about the work or environment"], "skill": null or {"name": "...", "description": "one line on when to use it", "body": "Markdown: when to use, steps, commands that worked, pitfalls, the user\'s preferences"}}',
      'Rules: keep only what will still matter next week. Do not repeat anything already known (listed below). Each note is one sentence.',
      'Add a skill only for a multi-step task you are likely to do again, or to improve an existing skill (reuse its exact name and give the whole improved body). Most turns need no skill.',
      'If nothing is worth keeping, reply {"user": [], "memory": [], "skill": null}.',
      `\nAlready known about the user:\n${about.map((e) => `- ${e}`).join('\n') || '(nothing)'}`,
      `\nYour notes already:\n${notes.map((e) => `- ${e}`).join('\n') || '(nothing)'}`,
      `\nYour skills already:\n${skillText || '(none)'}`,
    ].join('\n'),
    items: [{ role: 'user', text: `The work to review:\n\n${transcript(o.turn)}` }],
  });
  const m = reply.text.match(/\{[\s\S]*\}/);
  if (!m) return;
  let plan: { user?: unknown; memory?: unknown; skill?: any };
  try { plan = JSON.parse(m[0]); } catch { return; }

  const ctx = { userId: o.userId, botId: o.botId, signal: AbortSignal.timeout(10_000) };
  let saved = 0;
  for (const [target, list] of [['user', plan.user], ['memory', plan.memory]] as const) {
    for (const text of (Array.isArray(list) ? list : []).slice(0, 4)) {
      const t = String(text ?? '').trim();
      if (t.length < 4 || t.length > 400) continue;
      const r = memoryTool({ action: 'add', target, text: t }, ctx);
      if (!r.isError && r.output !== 'Already remembered.') saved++;
    }
  }
  let skillNote = '';
  const sk = plan.skill;
  if (sk && typeof sk === 'object' && String(sk.name ?? '').trim() && String(sk.body ?? '').trim().length > 40) {
    try {
      const isNew = saveSkill(o.userId, o.botId, { name: String(sk.name), description: String(sk.description ?? ''), body: String(sk.body) });
      skillNote = `${isNew ? 'learned the skill' : 'improved the skill'} “${String(sk.name).trim().slice(0, 60)}”`;
    } catch { /* not a usable skill */ }
  }
  if (!saved && !skillNote) return;
  const parts = [saved ? `remembered ${saved} new thing${saved === 1 ? '' : 's'}` : '', skillNote].filter(Boolean);
  appendRow(o.botId, 'event', { type: 'event', event: 'learned', text: `Learned from this: ${parts.join(' and ')}.` });
}
