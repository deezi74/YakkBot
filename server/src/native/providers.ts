import { db, now } from '../db.js';
import { env } from '../env.js';
import type { EngineProvider } from '../types.js';
import { bridge, pairing } from '../device.js';
import { engine as localEngine, installedModels } from './localModels.js';

/**
 * Model providers for the built-in engine. Bring any model: Claude through the Anthropic API, or
 * anything that speaks the OpenAI chat-completions protocol (OpenAI, OpenRouter, xAI, Gemini, Groq,
 * a local Ollama, or your own endpoint).
 *
 * A key comes from the app (Settings, stored in the database on this device) or from the environment.
 */

export type Wire = 'anthropic' | 'openai';

export interface ProviderDef {
  id: string;
  name: string;
  wire: Wire;
  baseUrl: string;
  /** Environment variable that can hold the key. */
  envKey: string;
  /** Models offered before the provider's own list has been fetched. The first is the default. */
  models: string[];
  /** Runs without a key (a local server). */
  keyless?: boolean;
  keyHint?: string;
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', name: 'Claude (Anthropic)', wire: 'anthropic', baseUrl: process.env.ANTHROPIC_BASE_URL ?? '', envKey: 'ANTHROPIC_API_KEY', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'], keyHint: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', wire: 'openai', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: [], keyHint: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', wire: 'openai', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', models: [], keyHint: 'sk-or-…' },
  { id: 'xai', name: 'Grok (xAI)', wire: 'openai', baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', models: [env.xaiModel], keyHint: 'xai-…' },
  { id: 'gemini', name: 'Gemini (Google)', wire: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY', models: [] },
  { id: 'groq', name: 'Groq', wire: 'openai', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', models: [], keyHint: 'gsk_…' },
  { id: 'ollama', name: 'Ollama (local models)', wire: 'openai', baseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''), envKey: 'OLLAMA_API_KEY', models: [], keyless: true },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', wire: 'openai', baseUrl: (process.env.CUSTOM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, ''), envKey: 'CUSTOM_API_KEY', models: [] },
  // GGUF models downloaded to the phone and run by the YakkBot app (llama.cpp), offline.
  // Last, so a bot with no provider of its own only falls back to it when nothing else is set up.
  { id: 'phone', name: 'On this device (offline)', wire: 'openai', baseUrl: `http://127.0.0.1:${process.env.YAKK_MODEL_PORT ?? 8081}/v1`, envKey: 'PHONE_MODEL_KEY', models: [], keyless: true },
];

db.exec(`CREATE TABLE IF NOT EXISTS provider_keys (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL DEFAULT '',
  base_url TEXT,
  default_model TEXT,
  updated_at INTEGER NOT NULL
)`);

export const providerDef = (id: string | null | undefined) => PROVIDERS.find((p) => p.id === id) ?? null;

const stored = (id: string) => db.prepare('SELECT * FROM provider_keys WHERE provider=?').get(id) as any;

export function providerKey(id: string): string {
  const def = providerDef(id);
  if (!def) return '';
  return stored(id)?.api_key || process.env[def.envKey] || '';
}

export function providerBaseUrl(id: string): string {
  const def = providerDef(id);
  if (!def) return '';
  return String(stored(id)?.base_url || def.baseUrl || '').replace(/\/+$/, '');
}

/** A provider can run a turn: it has a key, or it is a local server someone pointed us at. */
export function providerConnected(id: string): boolean {
  const def = providerDef(id);
  if (!def) return false;
  if (def.id === 'phone') { void phoneModels(); return phoneCache.files.length > 0; }
  if (def.id === 'custom') return !!providerBaseUrl(id);
  if (def.keyless) return !!stored(id) || !!process.env.OLLAMA_BASE_URL || !!process.env[def.envKey];
  return !!providerKey(id);
}

export function setProviderKey(id: string, p: { apiKey?: string | null; baseUrl?: string | null; defaultModel?: string | null }) {
  const def = providerDef(id);
  if (!def) throw new Error('Unknown provider');
  const cur = stored(id);
  const next = {
    api_key: p.apiKey === undefined ? cur?.api_key ?? '' : (p.apiKey ?? '').trim(),
    base_url: p.baseUrl === undefined ? cur?.base_url ?? null : (p.baseUrl ?? '').trim() || null,
    default_model: p.defaultModel === undefined ? cur?.default_model ?? null : (p.defaultModel ?? '').trim() || null,
  };
  if (next.base_url && !/^https?:\/\//.test(next.base_url)) throw new Error('The address must start with http:// or https://');
  db.prepare(`INSERT INTO provider_keys(provider,api_key,base_url,default_model,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key, base_url=excluded.base_url, default_model=excluded.default_model, updated_at=excluded.updated_at`)
    .run(id, next.api_key, next.base_url, next.default_model, now());
  modelCache.delete(id);
}

export function removeProviderKey(id: string) {
  db.prepare('DELETE FROM provider_keys WHERE provider=?').run(id);
  modelCache.delete(id);
}

// ---------- model lists ----------

const modelCache = new Map<string, { at: number; models: string[] }>();

/** Ask the provider which models it serves (OpenAI-style GET /models). Falls back to the built-in list. */
export async function providerModels(id: string): Promise<string[]> {
  const def = providerDef(id);
  if (!def) return [];
  if (def.id === 'phone') return phoneModels();
  const pinned = [stored(id)?.default_model, process.env[`${id.toUpperCase()}_MODEL`]].filter(Boolean) as string[];
  if (def.wire === 'anthropic' || !providerConnected(id)) return [...new Set([...pinned, ...def.models])];
  const hit = modelCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return [...new Set([...pinned, ...def.models, ...hit.models])];
  let models: string[] = [];
  try {
    const key = providerKey(id);
    const r = await fetch(`${providerBaseUrl(id)}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const j: any = await r.json();
      models = (Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []).map((m: any) => String(m?.id ?? m?.name ?? '')).filter(Boolean).map((m: string) => m.replace(/^models\//, ''));
    }
  } catch { /* offline or not an OpenAI-style server: the built-in list still works */ }
  modelCache.set(id, { at: Date.now(), models });
  return [...new Set([...pinned, ...def.models, ...models])];
}

export function defaultModel(id: string): string | null {
  const def = providerDef(id);
  if (!def) return null;
  if (def.id === 'phone') return stored(id)?.default_model || phoneCache.files[0] || null;
  return stored(id)?.default_model || process.env[`${id.toUpperCase()}_MODEL`] || def.models[0] || modelCache.get(id)?.models[0] || null;
}

/** The provider a bot uses when it has not picked one: the first that can run. */
export function defaultProvider(): string | null {
  const preferred = process.env.YAKK_PROVIDER;
  if (preferred && providerConnected(preferred)) return preferred;
  return PROVIDERS.find((p) => providerConnected(p.id))?.id ?? null;
}

export async function listProviders(): Promise<EngineProvider[]> {
  const out: EngineProvider[] = [];
  await phoneModels();
  for (const p of PROVIDERS) {
    // On-device models: the app's engine, or llama-server here.
    if (p.id === 'phone' && !(env.inApp ? pairing() : localEngine())) continue;
    const connected = providerConnected(p.id);
    out.push({
      id: p.id, name: p.name, kind: 'api_key', connected,
      models: (connected ? await providerModels(p.id) : p.models).slice(0, 200),
      keyless: !!p.keyless, needsBaseUrl: p.id === 'custom' || p.id === 'ollama',
      baseUrl: p.id === 'custom' || p.id === 'ollama' ? providerBaseUrl(p.id) : undefined,
      keyHint: p.keyHint, fromEnv: connected && !stored(p.id)?.api_key && !!process.env[p.envKey],
      defaultModel: defaultModel(p.id),
    });
  }
  return out.sort((a, b) => Number(b.connected) - Number(a.connected));
}

// ---------- models on the phone (the YakkBot app's llama.cpp) ----------

const phoneCache: { at: number; files: string[] } = { at: 0, files: [] };

/** The .gguf files downloaded in the app, cached for a few seconds. Empty without the app. */
export async function phoneModels(): Promise<string[]> {
  // Outside the app: the models this server downloaded, if llama-server is installed.
  if (!env.inApp) return (phoneCache.files = localEngine() ? installedModels().map((m) => m.file) : []);
  if (!pairing()) return (phoneCache.files = []);
  if (Date.now() - phoneCache.at < 5000) return phoneCache.files;
  phoneCache.at = Date.now();
  try {
    const s = await bridge('/models/status', {}, 4000);
    phoneCache.files = s.engine ? (s.installed ?? []).map((m: any) => String(m.file)) : [];
  } catch { /* the app is not answering: keep what we knew */ }
  return phoneCache.files;
}

export const forgetPhoneModels = () => { phoneCache.at = 0; };
