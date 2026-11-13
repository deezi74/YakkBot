import Anthropic from '@anthropic-ai/sdk';
import { providerBaseUrl, providerDef, providerKey } from './providers.js';
import { bridge } from '../device.js';

/**
 * One model call, streamed. The conversation is kept in a provider-neutral form (Item) and turned
 * into the provider's own messages here, so a bot can change model mid-conversation.
 */

export interface Image { mime: string; data: string }
export interface Call { id: string; name: string; args: any }

export type Item =
  | { role: 'user'; text: string; images?: Image[] }
  | {
      role: 'assistant'; text: string; calls: Call[];
      /** Anthropic only: the response's content blocks exactly as returned (thinking blocks must be replayed unchanged). */
      raw?: any[];
      /** Model that produced `raw`; another model gets the plain form. */
      model?: string;
    }
  | { role: 'tool'; id: string; name: string; output: string; isError?: boolean; image?: Image };

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export type Delta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning-start' };

export interface Reply {
  text: string;
  calls: Call[];
  raw?: any[];
  stop: 'end' | 'tools' | 'length' | 'refusal';
  note?: string;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

export interface LlmRequest {
  provider: string;
  model: string;
  system: string;
  items: Item[];
  tools: ToolSpec[];
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  signal: AbortSignal;
  /** Replay Anthropic thinking blocks (only valid while system, tools and earlier messages are unchanged). */
  keepThinking: boolean;
  onDelta: (d: Delta) => void;
}

export class LlmError extends Error {
  constructor(message: string, public status?: number, public retryable = false) { super(message); }
}

// ---------- Anthropic ----------

/** Claude 4.6 and later: adaptive thinking and the effort setting. Older models take neither in this form. */
const adaptive = (model: string) => /claude-(fable|mythos)-|claude-(opus|sonnet|haiku)-(4-[6-9]|[5-9])/.test(model);
/** Models where a safety decline can be re-run on a fallback model inside the same request. */
const hasFallbacks = (model: string) => /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/.test(model);

function anthropicMessages(items: Item[], model: string, keepThinking: boolean): any[] {
  const out: any[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const it of items) {
    if (it.role === 'user') {
      push('user', [
        ...(it.images ?? []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
        { type: 'text', text: it.text || '(empty)' },
      ]);
    } else if (it.role === 'assistant') {
      if (it.raw && it.model === model) {
        const blocks = keepThinking ? it.raw : it.raw.filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
        if (blocks.length) { out.push({ role: 'assistant', content: blocks }); continue; }
      }
      const blocks: any[] = [];
      if (it.text.trim()) blocks.push({ type: 'text', text: it.text });
      for (const c of it.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else {
      const content: any[] = [{ type: 'text', text: it.output || '(no output)' }];
      if (it.image) content.push({ type: 'image', source: { type: 'base64', media_type: it.image.mime, data: it.image.data } });
      // All results of one assistant turn go back in a single user message.
      push('user', [{ type: 'tool_result', tool_use_id: it.id, content, ...(it.isError ? { is_error: true } : {}) }]);
    }
  }
  return out;
}

const clients = new Map<string, Anthropic>();
function anthropicClient(provider: string): Anthropic {
  const key = providerKey(provider);
  const base = providerBaseUrl(provider);
  const id = `${key}|${base}`;
  let c = clients.get(id);
  if (!c) {
    c = new Anthropic({ apiKey: key, ...(base ? { baseURL: base } : {}), maxRetries: 3 });
    clients.set(id, c);
  }
  return c;
}

async function callAnthropic(req: LlmRequest): Promise<Reply> {
  const client = anthropicClient(req.provider);
  const firstParty = !providerBaseUrl(req.provider);
  const fallbacks = firstParty && hasFallbacks(req.model) && process.env.ANTHROPIC_FALLBACKS !== '0';
  const params: any = {
    model: req.model,
    max_tokens: 32000,
    // The system prompt is frozen for the conversation, so it and the growing history stay cached.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    messages: anthropicMessages(req.items, req.model, req.keepThinking),
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    ...(adaptive(req.model) ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: req.effort } } : {}),
    // A request the safety system declines is re-run on a fallback model in the same call.
    ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };
  try {
    const stream: any = fallbacks ? (client.beta.messages as any).stream(params, { signal: req.signal }) : (client.messages as any).stream(params, { signal: req.signal });
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') req.onDelta({ type: 'reasoning-start' });
      else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') req.onDelta({ type: 'text', text: ev.delta.text });
        else if (ev.delta?.type === 'thinking_delta') req.onDelta({ type: 'reasoning', text: ev.delta.thinking });
      }
    }
    const msg: any = await stream.finalMessage();
    const blocks: any[] = msg.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const calls: Call[] = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    const usage = { input: msg.usage?.input_tokens, output: msg.usage?.output_tokens, cacheRead: msg.usage?.cache_read_input_tokens };
    if (msg.stop_reason === 'refusal') {
      return { text, calls: [], stop: 'refusal', note: msg.stop_details?.explanation ?? undefined, usage };
    }
    if (msg.stop_reason === 'max_tokens') return { text, calls: [], stop: 'length', usage };
    // Fallback blocks and anything else the API returned are replayed as they came.
    return { text, calls, raw: blocks, stop: calls.length ? 'tools' : 'end', usage };
  } catch (e: any) {
    if (req.signal.aborted) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic did not accept the API key. Check it in Settings.', 401);
    if (e instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic is rate limiting this key. Try again in a moment.', 429, true);
    if (e instanceof Anthropic.APIError) throw new LlmError(String(e.message).slice(0, 400), e.status, (e.status ?? 0) >= 500);
    throw e;
  }
}

/** A replayed thinking block no longer fits the conversation (history, system or tools changed since). */
export const isThinkingMismatch = (e: unknown) => e instanceof LlmError && e.status === 400 && /signature|thinking/i.test(e.message);

// ---------- OpenAI-compatible chat completions ----------

function openaiMessages(system: string, items: Item[]): any[] {
  const out: any[] = [{ role: 'system', content: system }];
  for (const it of items) {
    if (it.role === 'user') {
      out.push(it.images?.length
        ? { role: 'user', content: [{ type: 'text', text: it.text || '(empty)' }, ...it.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))] }
        : { role: 'user', content: it.text || '(empty)' });
    } else if (it.role === 'assistant') {
      if (!it.text.trim() && !it.calls.length) continue;
      out.push({
        role: 'assistant',
        content: it.text || null,
        ...(it.calls.length ? { tool_calls: it.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: it.id, content: it.output || '(no output)' });
      // Tool messages carry text only; a screenshot follows as a user message.
      if (it.image) out.push({ role: 'user', content: [{ type: 'text', text: `[image returned by ${it.name}]` }, { type: 'image_url', image_url: { url: `data:${it.image.mime};base64,${it.image.data}` } }] });
    }
  }
  return out;
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, end).trim();
      buf = buf.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try { yield JSON.parse(raw); } catch { /* a partial or foreign line */ }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callOpenAI(req: LlmRequest): Promise<Reply> {
  const def = providerDef(req.provider)!;
  // A model on the phone: the app loads it first (the first time can take a minute).
  if (def.id === 'phone') {
    req.onDelta({ type: 'reasoning-start' });
    await bridge('/models/use', { file: req.model, ctx: 12288 }, 240_000);
  }
  const base = providerBaseUrl(req.provider);
  if (!base) throw new LlmError(`${def.name} has no address yet. Set it in Settings.`);
  const key = providerKey(req.provider);
  const body = JSON.stringify({
    model: req.model,
    stream: true,
    messages: openaiMessages(req.system, req.items),
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
  });

  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal: req.signal, body,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(def.id === 'openrouter' ? { 'X-Title': 'YakkBot' } : {}) },
      });
    } catch (e: any) {
      if (req.signal.aborted) throw e;
      if (attempt >= 2) throw new LlmError(`Could not reach ${def.name} at ${base}: ${e?.cause?.code ?? e?.message ?? e}`, undefined, true);
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (res.ok && res.body) break;
    const raw = await res.text().catch(() => '');
    let msg = raw.slice(0, 400);
    try { const j = JSON.parse(raw); msg = String(j?.error?.message ?? j?.message ?? j?.error ?? msg).slice(0, 400); } catch { /* plain text */ }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (res.status === 401 || res.status === 403) throw new LlmError(`${def.name} did not accept the API key. Check it in Settings.`, res.status);
    throw new LlmError(`${def.name}: ${msg || `HTTP ${res.status}`}`, res.status, res.status >= 500);
  }

  let text = '';
  let finish = '';
  let reasoningOpen = false;
  const acc: { id: string; name: string; args: string }[] = [];
  let usage: Reply['usage'];
  for await (const ev of sseData(res!.body!)) {
    if (ev?.error) throw new LlmError(`${def.name}: ${String(ev.error?.message ?? ev.error).slice(0, 400)}`);
    if (ev?.usage) usage = { input: ev.usage.prompt_tokens, output: ev.usage.completion_tokens, cacheRead: ev.usage.prompt_tokens_details?.cached_tokens };
    const ch = ev?.choices?.[0];
    if (!ch) continue;
    const d = ch.delta ?? {};
    const think = d.reasoning_content ?? d.reasoning;
    if (typeof think === 'string' && think) {
      if (!reasoningOpen) { reasoningOpen = true; req.onDelta({ type: 'reasoning-start' }); }
      req.onDelta({ type: 'reasoning', text: think });
    }
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      req.onDelta({ type: 'text', text: d.content });
    }
    for (const tc of d.tool_calls ?? []) {
      const i = typeof tc.index === 'number' ? tc.index : acc.length ? acc.length - 1 : 0;
      const slot = (acc[i] ??= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const calls: Call[] = acc.filter((c) => c && c.name).map((c, i) => {
    let args: any = {};
    try { args = c.args.trim() ? JSON.parse(c.args) : {}; } catch { args = { __invalid_json: c.args.slice(0, 2000) }; }
    return { id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.name, args };
  });
  if (finish === 'length' && !calls.length) return { text, calls: [], stop: 'length', usage };
  if (finish === 'content_filter') return { text, calls: [], stop: 'refusal', usage };
  return { text, calls, stop: calls.length ? 'tools' : 'end', usage };
}

export function callModel(req: LlmRequest): Promise<Reply> {
  const def = providerDef(req.provider);
  if (!def) throw new LlmError(`Unknown model provider "${req.provider}".`);
  return def.wire === 'anthropic' ? callAnthropic(req) : callOpenAI(req);
}
