import { db } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { appendRow, clearConversation, emitBot, getBotRow, getRow, updateRow } from '../store.js';
import { enqueue, interrupt, resolveApproval } from '../agent/loop.js';
import type { Row, ServerEvent } from '../types.js';

/**
 * Text your bots from Telegram (the phone-friendly stand-in for Bot HQ's iMessage bridge).
 *
 * Set TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_ALLOWED_CHATS (your chat id; message the bot
 * once and it tells you the id). Messages go to your main bot unless you pick another with /bot.
 * Replies come back to the chat, and approval and question cards arrive as buttons.
 * Uses long polling, so nothing has to be reachable from the internet.
 */

const API = () => `https://api.telegram.org/bot${env.telegramToken}`;
const ROUTE_TTL = 6 * 3600_000;

/** bot -> the chat its replies go to, while the conversation there is fresh. */
const routes = new Map<string, { chat: string; at: number }>();
/** chat -> the bot it is talking to. */
const targets = new Map<string, string>();
const sent = new Set<string>();
let subscribedUser: string | null = null;

async function tg(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  const r = await fetch(`${API()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

async function say(chat: string, text: string, buttons?: { text: string; data: string }[][]) {
  const parts = text.match(/[\s\S]{1,3900}/g) ?? [''];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await tg('sendMessage', { chat_id: chat, text: parts[i], disable_web_page_preview: true, ...(last && buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}) })
      .catch((e) => console.warn('[telegram]', e.message));
  }
}

const owner = () => (db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get() as any)?.id as string | undefined;
const agents = (userId: string) => db.prepare("SELECT id, name, label, is_primary FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at").all(userId) as any[];

function targetFor(chat: string, userId: string): any | null {
  const list = agents(userId);
  return list.find((b) => b.id === targets.get(chat)) ?? list[0] ?? null;
}

function onEvent(ev: ServerEvent) {
  if (ev.type !== 'rows') return;
  const route = routes.get(ev.botId);
  if (!route || Date.now() - route.at > ROUTE_TTL) return;
  for (const row of ev.rows) void forward(route.chat, row);
}

async function forward(chat: string, row: Row) {
  const key = `${row.botId}:${row.generation}:${row.seq}`;
  const b = row.body;
  const name = getBotRow(row.botId)?.name ?? 'Bot';
  if (b.type === 'message' && b.role === 'assistant' && !b.streaming && b.text.trim()) {
    if (sent.has(key)) return;
    sent.add(key);
    await say(chat, targets.size > 1 || agents(owner() ?? '').length > 1 ? `${name}: ${b.text}` : b.text);
  } else if (b.type === 'card' && b.status === 'pending') {
    if (sent.has(key)) return;
    sent.add(key);
    if (b.card === 'approval') await say(chat, `${b.title}\n${b.detail}`.trim(), [[{ text: 'Allow', data: `ap:${b.approvalId}:allow` }, { text: 'Always allow', data: `ap:${b.approvalId}:always` }, { text: "Don't allow", data: `ap:${b.approvalId}:deny` }]]);
    else if (b.card === 'question') await say(chat, b.question, b.options.map((o, i) => [{ text: o.slice(0, 60), data: `q:${row.botId}:${row.seq}:${i}` }]));
    else if (b.card === 'connect') await say(chat, `${name} wants to connect ${b.toolkitName}: ${b.reason}\nOpen the app to connect it.`);
  } else if (b.type === 'notice' && b.tone === 'error') {
    if (sent.has(key)) return;
    sent.add(key);
    await say(chat, `⚠ ${b.text}`);
  }
  if (sent.size > 5000) sent.clear();
}

async function onMessage(m: any) {
  const chat = String(m.chat?.id ?? '');
  const text = String(m.text ?? '').trim();
  if (!chat || !text) return;
  if (!env.telegramChats.includes(chat)) {
    console.log(`[telegram] message from chat ${chat}, which is not in TELEGRAM_ALLOWED_CHATS`);
    await say(chat, `This chat is not allowed to talk to this YakkBot yet.\nIf it is yours, add this id to TELEGRAM_ALLOWED_CHATS and restart:\n${chat}`);
    return;
  }
  const userId = owner();
  if (!userId) return say(chat, 'Open the YakkBot app and sign in once first; then I can reach your bots.');
  if (subscribedUser !== userId) { hub.subscribe(userId, onEvent); subscribedUser = userId; }

  const [cmd, ...rest] = text.split(/\s+/);
  if (cmd === '/start' || cmd === '/help') {
    return say(chat, `You are talking to ${targetFor(chat, userId)?.name ?? 'your bot'}.\n/bots lists your bots\n/bot <name> switches\n/new starts a fresh conversation\n/stop stops what it is doing`);
  }
  if (cmd === '/bots') return say(chat, agents(userId).map((b) => `${b.id === targetFor(chat, userId)?.id ? '→' : '  '} ${b.name}${b.label ? ` (${b.label})` : ''}`).join('\n') || 'No bots yet.');
  if (cmd === '/bot') {
    const want = rest.join(' ').toLowerCase();
    const hit = agents(userId).find((b) => b.name.toLowerCase() === want) ?? agents(userId).find((b) => want && b.name.toLowerCase().startsWith(want));
    if (!hit) return say(chat, `No bot named "${rest.join(' ')}". Try /bots.`);
    targets.set(chat, hit.id);
    return say(chat, `Now talking to ${hit.name}.`);
  }
  const bot = targetFor(chat, userId);
  if (!bot) return say(chat, 'You have no bots yet. Create one in the app.');
  routes.set(bot.id, { chat, at: Date.now() });
  if (cmd === '/stop') { interrupt(bot.id); return say(chat, 'Stopped.'); }
  if (cmd === '/new') { interrupt(bot.id); clearConversation(bot.id); emitBot(bot.id); return say(chat, `Fresh conversation with ${bot.name}.`); }
  appendRow(bot.id, 'message', { type: 'message', role: 'user', text });
  enqueue(bot.id, { type: 'user', text });
  tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
}

async function onCallback(q: any) {
  const chat = String(q.message?.chat?.id ?? '');
  const data = String(q.data ?? '');
  const userId = owner();
  const done = (text: string) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (!userId || !env.telegramChats.includes(chat)) return done('Not allowed');
  try {
    if (data.startsWith('ap:')) {
      const [, id, decision] = data.split(':');
      resolveApproval(userId, id, decision as 'allow' | 'always' | 'deny');
      return done(decision === 'deny' ? 'Not allowed' : 'Allowed');
    }
    if (data.startsWith('q:')) {
      const [, botId, seq, idx] = data.split(':');
      const b = getBotRow(botId);
      const row = b?.user_id === userId ? getRow(botId, Number(seq)) : null;
      if (!row || row.body.type !== 'card' || row.body.card !== 'question' || row.body.status !== 'pending') return done('Already answered');
      const answer = row.body.options[Number(idx)];
      if (!answer) return done('Unknown option');
      updateRow(botId, row.seq, { ...row.body, status: 'answered', answer });
      appendRow(botId, 'message', { type: 'message', role: 'user', text: answer });
      routes.set(botId, { chat, at: Date.now() });
      enqueue(botId, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
      return done(answer.slice(0, 60));
    }
  } catch { /* an old button */ }
  return done('That is no longer waiting.');
}

export function initTelegram() {
  if (!env.telegramToken) return;
  if (!env.telegramChats.length) console.log('[telegram] no TELEGRAM_ALLOWED_CHATS yet: message the bot and it will tell you your chat id');
  let offset = 0;
  const poll = async () => {
    for (;;) {
      try {
        const updates: any[] = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          if (u.message) await onMessage(u.message).catch((e) => console.warn('[telegram] message failed', e?.message ?? e));
          else if (u.callback_query) await onCallback(u.callback_query);
        }
      } catch (e: any) {
        if (!/timeout|aborted/i.test(String(e?.message))) console.warn('[telegram] poll failed:', e?.message ?? e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void poll();
  console.log('[telegram] bridge on');
}
