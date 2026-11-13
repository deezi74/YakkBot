import crypto from 'node:crypto';
import { db } from '../db.js';
import { env } from '../env.js';
import { composioTools } from '../composio.js';
import { callAppTool } from '../mcp.js';
import { claimToolRow, noteToolOutcome, requestApproval } from '../agent/loop.js';
import { TOOLS, toolMap } from '../agent/tools.js';
import { ensureHome, memoryBlock } from './home.js';
import { callModel, isThinkingMismatch, LlmError, type Call, type Item, type ToolSpec } from './llm.js';
import { defaultModel, defaultProvider, providerConnected, providerDef } from './providers.js';
import { deviceTools, policyMode, type DeviceResult } from './tools.js';

/**
 * YakkBot's own agent loop: model call, tool calls, repeat. It reports progress in the same event
 * vocabulary a Hermes gateway streams (response.output_text.delta, response.output_item.added, ...),
 * so the turn code in agent/loop.ts treats both engines alike.
 */

export interface StreamEvent { type: string; data: any }

db.exec(`CREATE TABLE IF NOT EXISTS native_sessions (
  bot_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  prefix_hash TEXT NOT NULL,
  system TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation)
)`);

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this (they sent a new message or did not answer in time). Do not retry unless they ask.';

// ---------- history ----------

const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;

function loadItems(botId: string, generation: number): Item[] {
  return (db.prepare('SELECT item FROM llm_items WHERE bot_id=? AND generation=? ORDER BY idx ASC').all(botId, generation) as any[]).map((r) => JSON.parse(r.item));
}

function appendItems(botId: string, generation: number, items: Item[]) {
  if (!items.length) return;
  const start = ((db.prepare('SELECT MAX(idx) m FROM llm_items WHERE bot_id=? AND generation=?').get(botId, generation) as any).m ?? -1) + 1;
  const ins = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)');
  db.transaction(() => items.forEach((it, i) => ins.run(botId, generation, start + i, JSON.stringify(it))))();
}

function replaceItems(botId: string, generation: number, items: Item[]) {
  db.transaction(() => {
    db.prepare('DELETE FROM llm_items WHERE bot_id=? AND generation=?').run(botId, generation);
    const ins = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)');
    items.forEach((it, i) => ins.run(botId, generation, i, JSON.stringify(it)));
  })();
}

/** An interrupted turn can leave tool calls without results; every provider rejects that. */
function repair(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    out.push(it);
    if (it.role !== 'assistant' || !it.calls.length) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < items.length && items[j].role === 'tool'; j++) answered.add((items[j] as any).id);
    const missing = it.calls.filter((c) => !answered.has(c.id));
    if (!missing.length) continue;
    // Copy the results that exist, then fill the gaps, so they stay next to their calls.
    let j = i + 1;
    for (; j < items.length && items[j].role === 'tool'; j++) out.push(items[j]);
    for (const c of missing) out.push({ role: 'tool', id: c.id, name: c.name, output: 'Interrupted before this finished.', isError: true });
    i = j - 1;
  }
  return out;
}

const size = (items: Item[]) => items.reduce((n, it) => n + (it.role === 'user' ? it.text.length + (it.images?.length ?? 0) * 1500 : it.role === 'assistant' ? it.text.length + JSON.stringify(it.calls).length : it.output.length + (it.image ? 1500 : 0)), 0);

/** Only the newest screenshots are worth their tokens; older ones become a note. */
function pruneImages(items: Item[], keep = 3): { items: Item[]; pruned: boolean } {
  let seen = 0;
  let pruned = false;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const it = out[i];
    if (it.role === 'tool' && it.image) {
      if (++seen > keep) { out[i] = { ...it, image: undefined, output: `${it.output}\n[older image left out]` }; pruned = true; }
    } else if (it.role === 'user' && it.images?.length) {
      if ((seen += it.images.length) > keep + 2) { out[i] = { role: 'user', text: `${it.text}\n[older image left out]` }; pruned = true; }
    }
  }
  return { items: out, pruned };
}

function transcriptFor(items: Item[]): string {
  return items.map((it) => {
    if (it.role === 'user') return `USER: ${it.text}`;
    if (it.role === 'assistant') return `ASSISTANT: ${it.text}${it.calls.length ? `\n[called ${it.calls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 300)})`).join(', ')}]` : ''}`;
    return `TOOL ${it.name}: ${it.output.slice(0, 1500)}`;
  }).join('\n\n');
}

// ---------- tools ----------

interface Toolbox { specs: ToolSpec[]; device: Map<string, ReturnType<typeof deviceTools>[number]> }

async function toolbox(userId: string): Promise<Toolbox> {
  const device = deviceTools();
  // x_search needs an xAI key; the rest of the app's tools always work.
  const app = TOOLS.filter((t) => (t.name === 'x_search' ? !!env.xaiKey : t.name.includes('event') || t.name === 'request_app_connection' ? !!env.composioKey : true));
  const apps = (await composioTools(userId))
    .filter((t: any) => t?.type === 'function' && typeof t.name === 'string' && !toolMap.has(t.name))
    .map((t: any): ToolSpec => ({ name: t.name, description: String(t.description ?? ''), parameters: t.parameters ?? { type: 'object', properties: {} } }));
  const specs: ToolSpec[] = [
    ...device.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ...app.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ...apps,
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { specs, device: new Map(device.map((t) => [t.name, t])) };
}

async function runDeviceTool(box: Toolbox, who: { userId: string; botId: string }, call: Call, signal: AbortSignal): Promise<DeviceResult> {
  const tool = box.device.get(call.name)!;
  const rowSeq = await claimToolRow(who.botId, call.name);
  try {
    if (call.args?.__invalid_json !== undefined) throw new Error('The arguments were not valid JSON. Send them again.');
    const gate = tool.gate?.(call.args) ?? null;
    if (gate) {
      const mode = policyMode(who.userId, gate.key) ?? 'needs_approval';
      if (mode === 'blocked') {
        noteToolOutcome(who.botId, rowSeq, { status: 'denied', summary: 'Not allowed' });
        return { output: DECLINED, isError: true };
      }
      if (mode !== 'always_allow') {
        const answer = await requestApproval(who, gate, call.args, rowSeq);
        if (answer !== 'allow') return { output: answer === 'deny' ? DECLINED : SKIPPED, isError: true };
      }
    }
    const r = await tool.impl(call.args ?? {}, { ...who, signal });
    noteToolOutcome(who.botId, rowSeq, { status: r.isError ? 'error' : 'done', summary: r.summary ?? (r.isError ? r.output.split('\n').pop()?.slice(0, 120) : undefined) });
    return r;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    noteToolOutcome(who.botId, rowSeq, { status: 'error', summary: msg.slice(0, 200) });
    return { output: `Tool error: ${msg}`, isError: true };
  }
}

// ---------- the model for a bot ----------

export function modelFor(bot: any): { provider: string; model: string } {
  const provider = bot.provider && providerConnected(bot.provider) ? bot.provider : defaultProvider();
  if (!provider) throw new LlmError('No model is connected yet. Open Settings, pick a provider and paste an API key.');
  const model = (bot.provider === provider && bot.model) || defaultModel(provider);
  if (!model) throw new LlmError(`Pick a model for ${providerDef(provider)?.name ?? provider} in this bot's Engine panel.`);
  return { provider, model };
}

function stamp(): string {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[${d.toLocaleString('en-CA', { hour12: false }).replace(',', '')} ${tz}]`;
}

// ---------- the turn ----------

export interface NativeTurn {
  botId: string;
  userId: string;
  input: string;
  /** Builds the system prompt around the conversation's memory snapshot. Called once per turn. */
  system: (memory: string) => Promise<string>;
  signal: AbortSignal;
  /** A tool ended the turn (asked the user, stayed silent). */
  ended: () => boolean;
}

export async function* nativeTurn(t: NativeTurn): AsyncGenerator<StreamEvent> {
  const bot = botRow(t.botId);
  const gen: number = bot.generation;
  const { provider, model } = modelFor(bot);
  const home = ensureHome(t.botId);
  const box = await toolbox(t.userId);

  // Memory is read once per conversation and then held still: notes saved along the way are already
  // in the conversation, and a prompt that does not change stays cached. The rest of the system
  // prompt only changes when something real does (an edited persona, a new routine, a connected app);
  // then the new text is used and Claude's earlier thinking blocks, bound to the old one, are dropped.
  const session = db.prepare('SELECT * FROM native_sessions WHERE bot_id=? AND generation=?').get(t.botId, gen) as any;
  const memory: string = session?.system ?? memoryBlock(home);
  const system = await t.system(memory);
  const prefixHash = crypto.createHash('sha256').update(system).update(JSON.stringify(box.specs)).digest('hex');
  let keepThinking = !session || session.prefix_hash === prefixHash;
  if (!session || session.prefix_hash !== prefixHash) {
    db.prepare('INSERT OR REPLACE INTO native_sessions(bot_id,generation,prefix_hash,system) VALUES (?,?,?,?)').run(t.botId, gen, prefixHash, memory);
  }

  const saved = loadItems(t.botId, gen);
  let items = repair(saved);
  if (items.length !== saved.length) { replaceItems(t.botId, gen, items); keepThinking = false; }

  // Too long to keep sending: fold everything so far into a summary and carry on from that.
  if (size(items) > env.contextChars && items.length > 4) {
    yield { type: 'hermes.status', data: { text: 'Condensing the conversation so far' } };
    const summary = await callModel({
      provider, model, effort: 'low', signal: t.signal, keepThinking: false, tools: [],
      system: 'You condense a long working conversation between a user and an AI agent so the agent can continue from your summary alone. Keep: what the user asked for and prefers, decisions made, facts found, file paths, commands that worked, what is finished, what is still open. Be specific and complete; do not address anyone.',
      items: [{ role: 'user', text: transcriptFor(items).slice(-env.contextChars) }],
      onDelta: () => {},
    });
    items = [{ role: 'user', text: `[The conversation so far was condensed to save space. Summary:]\n${summary.text.trim() || '(nothing could be summarised)'}` }, { role: 'assistant', text: 'Understood. Continuing from there.', calls: [] }];
    replaceItems(t.botId, gen, items);
    keepThinking = false;
  }

  const userItem: Item = { role: 'user', text: `${stamp()}\n${t.input}` };
  appendItems(t.botId, gen, [userItem]);
  items.push(userItem);

  for (let step = 0; step < env.maxSteps; step++) {
    if (t.signal.aborted) throw new Error('interrupted');
    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    const emit = (e: StreamEvent) => { queue.push(e); wake?.(); };
    let streamed = '';

    const pruned = pruneImages(items);
    const request = (thinking: boolean) => callModel({
      provider, model, system, items: pruned.items, tools: box.specs, effort: bot.effort ?? 'medium', signal: t.signal,
      keepThinking: thinking && !pruned.pruned,
      onDelta: (d) => {
        if (d.type === 'text') { streamed += d.text; emit({ type: 'response.output_text.delta', data: { delta: d.text } }); }
        else if (d.type === 'reasoning') emit({ type: 'response.reasoning_summary_text.delta', data: { delta: d.text } });
        else emit({ type: 'response.output_item.added', data: { item: { type: 'reasoning' } } });
      },
    });

    let done = false;
    let failure: unknown = null;
    let reply: Awaited<ReturnType<typeof callModel>> | null = null;
    const pending = request(keepThinking)
      .catch((e) => {
        // Thinking blocks that no longer fit the conversation: send it again without them.
        if (!isThinkingMismatch(e) || streamed) throw e;
        keepThinking = false;
        return request(false);
      })
      .then((r) => { reply = r; }, (e) => { failure = e; })
      .finally(() => { done = true; wake?.(); });

    while (!done || queue.length) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      wake = null;
      while (queue.length) yield queue.shift()!;
    }
    await pending;
    if (failure) throw failure;
    const r = reply!;

    const assistant: Item = { role: 'assistant', text: r.text, calls: r.calls, ...(r.raw ? { raw: r.raw, model } : {}) };
    if (r.text.trim() || r.calls.length) {
      appendItems(t.botId, gen, [assistant]);
      items.push(assistant);
    }
    // Close the text written so far as a message of its own.
    yield { type: 'response.output_item.done', data: { item: { type: 'message', content: [{ text: r.text }] } } };

    if (r.stop === 'refusal') throw new LlmError(r.note ? `The model declined this request: ${r.note}` : 'The model declined this request.');
    if (r.stop === 'length') throw new LlmError('The reply was cut off at the length limit. Ask me to continue.');
    if (!r.calls.length) return;

    for (const call of r.calls) {
      if (t.signal.aborted) throw new Error('interrupted');
      yield { type: 'response.output_item.added', data: { item: { type: 'function_call', name: call.name, call_id: call.id, arguments: call.args } } };
      let result: DeviceResult;
      if (box.device.has(call.name)) result = await runDeviceTool(box, t, call, t.signal);
      else {
        const res = await callAppTool(t.botId, call.name, call.args ?? {});
        result = { output: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
      }
      const toolItem: Item = { role: 'tool', id: call.id, name: call.name, output: result.output, ...(result.isError ? { isError: true } : {}), ...(result.image ? { image: result.image } : {}) };
      appendItems(t.botId, gen, [toolItem]);
      items.push(toolItem);
      yield { type: 'response.output_item.done', data: { item: { type: 'function_call_output', call_id: call.id, output: result.isError ? JSON.stringify({ error: result.output.slice(0, 300) }) : result.output.slice(0, 2000) } } };
    }
    if (t.ended()) return;
  }
  throw new LlmError(`Stopped after ${env.maxSteps} steps without finishing. Say "continue" to keep going.`);
}
