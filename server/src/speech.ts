import { Hono } from 'hono';
import { env, getAppSettings, setAppSettings } from './env.js';
import type { AuthVars } from './lib/auth.js';
import { providerKey } from './native/providers.js';
import { FREE_VOICE_PORT, FREELLMAPI_PORT, freellmapiInstalled, portOpen, startService, voiceInstalled } from './services.js';

/**
 * Voice for every bot, whatever model it runs on: talk mode records you, turns speech into text,
 * sends it as a message, and reads the reply aloud. Several engines for each half:
 *  speaking  - device (the phone's or browser's own voice), free (edge-tts server, like D-Agent's),
 *              grok, openai, custom (any OpenAI-style /v1/audio/speech, e.g. Kokoro)
 *  listening - device (the browser's recognizer), groq (free tier Whisper), openai, grok
 * Grok's realtime voice calls stay available as their own mode when a Grok key is set.
 */
export const speechApi = new Hono<AuthVars>();

export type Tts = 'device' | 'free' | 'grok' | 'openai' | 'custom';
export type Stt = 'device' | 'groq' | 'openai' | 'grok';

const FREE_VOICES = [
  ['en-US-AvaNeural', 'Ava (US, warm)'], ['en-US-AndrewNeural', 'Andrew (US, warm)'], ['en-US-EmmaNeural', 'Emma (US, cheerful)'],
  ['en-US-BrianNeural', 'Brian (US, casual)'], ['en-US-JennyNeural', 'Jenny (US)'], ['en-US-GuyNeural', 'Guy (US)'],
  ['en-US-AriaNeural', 'Aria (US, news)'], ['en-US-ChristopherNeural', 'Christopher (US, deep)'], ['en-US-MichelleNeural', 'Michelle (US)'],
  ['en-GB-SoniaNeural', 'Sonia (UK)'], ['en-GB-RyanNeural', 'Ryan (UK)'], ['en-GB-LibbyNeural', 'Libby (UK)'],
  ['en-AU-NatashaNeural', 'Natasha (Australia)'], ['en-AU-WilliamNeural', 'William (Australia)'], ['en-IE-EmilyNeural', 'Emily (Ireland)'],
  ['en-IN-NeerjaNeural', 'Neerja (India)'], ['es-MX-DaliaNeural', 'Dalia (Spanish, Mexico)'], ['es-ES-AlvaroNeural', 'Álvaro (Spanish, Spain)'],
  ['fr-FR-DeniseNeural', 'Denise (French)'], ['de-DE-KatjaNeural', 'Katja (German)'], ['pt-BR-FranciscaNeural', 'Francisca (Portuguese, Brazil)'],
  ['it-IT-ElsaNeural', 'Elsa (Italian)'], ['ja-JP-NanamiNeural', 'Nanami (Japanese)'], ['hi-IN-SwaraNeural', 'Swara (Hindi)'],
].map(([id, name]) => ({ id, name }));
const OPENAI_VOICES = ['coral', 'nova', 'shimmer', 'sage', 'ballad', 'alloy', 'ash', 'echo', 'onyx', 'verse', 'fable'].map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1) }));
const GROK_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo', 'luna'].map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1) }));
const DEFAULT_VOICE: Record<Tts, string> = { device: '', free: 'en-US-AvaNeural', grok: 'eve', openai: 'coral', custom: 'af_heart' };

const keyFor = (id: 'openai' | 'groq') => providerKey(id);

export async function speechOptions() {
  const s = getAppSettings();
  const freeUp = await portOpen(FREE_VOICE_PORT, 1200);
  const tts = [
    { id: 'device', name: 'This phone’s voice', ready: true, note: 'Free, offline. Uses the voice set in Android (or your browser).', voices: [] as { id: string; name: string }[] },
    { id: 'free', name: 'Free natural voice', ready: freeUp, note: freeUp ? 'Running on this device (edge-tts), the same server D-Agent uses.' : voiceInstalled() ? 'Installed but not running. Tap Start.' : 'Free, natural voices. Tap Set up to install it here (Termux, PC or the app’s Linux).', voices: FREE_VOICES, installed: voiceInstalled() },
    { id: 'grok', name: 'Grok voice (xAI)', ready: !!env.xaiKey, note: env.xaiKey ? 'Uses your Grok key.' : 'Add a Grok (xAI) key in AI models.', voices: GROK_VOICES },
    { id: 'openai', name: 'OpenAI voice', ready: !!keyFor('openai'), note: keyFor('openai') ? 'Uses your OpenAI key.' : 'Add an OpenAI key in AI models.', voices: OPENAI_VOICES },
    { id: 'custom', name: 'Custom voice server', ready: !!s.ttsUrl, note: 'Any OpenAI-style speech server, e.g. Kokoro or a voice server on your PC.', voices: [] },
  ];
  const stt = [
    { id: 'device', name: 'This device', ready: true, note: 'Free. Uses the phone’s or browser’s speech recognition.' },
    { id: 'groq', name: 'Groq Whisper (free tier)', ready: !!keyFor('groq'), note: keyFor('groq') ? 'Fast and accurate.' : 'Add a free Groq key in AI models.' },
    { id: 'openai', name: 'OpenAI Whisper', ready: !!keyFor('openai'), note: keyFor('openai') ? 'Uses your OpenAI key.' : 'Add an OpenAI key in AI models.' },
    { id: 'grok', name: 'Grok (xAI)', ready: !!env.xaiKey, note: env.xaiKey ? 'Uses your Grok key.' : 'Add a Grok (xAI) key in AI models.' },
  ];
  const choice = currentChoice();
  return {
    tts, stt, settings: { ...choice, ttsUrl: s.ttsUrl ?? '' },
    realtime: !!env.xaiKey,
    services: { voice: { installed: voiceInstalled(), running: freeUp, port: FREE_VOICE_PORT }, freellmapi: { installed: freellmapiInstalled(), running: await portOpen(FREELLMAPI_PORT, 1200), port: FREELLMAPI_PORT } },
  };
}

/** The saved choice, falling back to what works: the free voice if it is set up, else the phone's own. */
export function currentChoice(): { tts: Tts; ttsVoice: string; stt: Stt; voiceMode: 'talk' | 'realtime' } {
  const s = getAppSettings();
  const tts = (['device', 'free', 'grok', 'openai', 'custom'].includes(s.tts ?? '') ? s.tts : voiceInstalled() ? 'free' : 'device') as Tts;
  const stt = (['device', 'groq', 'openai', 'grok'].includes(s.stt ?? '') ? s.stt : keyFor('groq') ? 'groq' : env.xaiKey ? 'grok' : 'device') as Stt;
  return { tts, ttsVoice: s.ttsVoice || DEFAULT_VOICE[tts], stt, voiceMode: s.voiceMode === 'realtime' && env.xaiKey ? 'realtime' : 'talk' };
}

speechApi.get('/options', async (c) => c.json(await speechOptions()));

speechApi.put('/settings', async (c) => {
  const p = await c.req.json<any>().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (['device', 'free', 'grok', 'openai', 'custom'].includes(p.tts)) { patch.tts = p.tts; if (p.tts !== getAppSettings().tts) patch.ttsVoice = undefined; }
  if (typeof p.ttsVoice === 'string') patch.ttsVoice = p.ttsVoice.slice(0, 80) || undefined;
  if (['device', 'groq', 'openai', 'grok'].includes(p.stt)) patch.stt = p.stt;
  if (p.voiceMode === 'talk' || p.voiceMode === 'realtime') patch.voiceMode = p.voiceMode;
  if (typeof p.ttsUrl === 'string') {
    const u = p.ttsUrl.trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return c.json({ error: 'The address should start with http:// or https://' }, 400);
    patch.ttsUrl = u || undefined;
  }
  setAppSettings(patch as any);
  return c.json(await speechOptions());
});

speechApi.post('/services/:name/start', async (c) => {
  const name = c.req.param('name');
  if (name !== 'voice' && name !== 'freellmapi') return c.json({ error: 'not found' }, 404);
  const r = await startService(name);
  if (r.ok) setAppSettings(name === 'voice' ? { autostartVoice: true } : { autostartFreellmapi: true });
  return c.json(r, r.ok ? 200 : 400);
});

/** Reads text aloud with the chosen engine (or the one asked for, to preview). Returns audio. */
speechApi.post('/speak', async (c) => {
  const p = await c.req.json<{ text?: string; tts?: Tts; voice?: string; speed?: number }>().catch(() => ({} as any));
  const choice = currentChoice();
  const tts = (p.tts ?? choice.tts) as Tts;
  const voice = String(p.voice || (p.tts && p.tts !== choice.tts ? DEFAULT_VOICE[tts] : choice.ttsVoice)).slice(0, 80);
  const speed = Math.min(1.5, Math.max(0.7, Number(p.speed) || 1));
  // Markdown and links read badly aloud.
  const text = String(p.text ?? '').replace(/```[\s\S]*?```/g, ' (code) ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, 'a link').replace(/[*_#>`|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!text) return c.json({ error: 'Nothing to say.' }, 400);
  if (tts === 'device') return c.json({ error: 'This voice plays on the device.' }, 400);
  let r: Response | null = null;
  try {
    if (tts === 'free') {
      if (!(await portOpen(FREE_VOICE_PORT, 1200))) {
        const s = voiceInstalled() ? await startService('voice') : { ok: false, message: 'Set up the free voice in Settings › Voice.' };
        if (!s.ok) return c.json({ error: `The free voice is not running. ${s.message}` }, 409);
      }
      r = await fetch(`http://127.0.0.1:${FREE_VOICE_PORT}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: text, voice, speed }), signal: AbortSignal.timeout(60_000) });
    } else if (tts === 'openai' || tts === 'custom') {
      const base = tts === 'openai' ? 'https://api.openai.com/v1' : getAppSettings().ttsUrl;
      if (!base) return c.json({ error: 'Set the custom voice server address first.' }, 409);
      const key = tts === 'openai' ? keyFor('openai') : '';
      if (tts === 'openai' && !key) return c.json({ error: 'Add an OpenAI key in Settings › AI models.' }, 409);
      r = await fetch(`${base}/audio/speech`, {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: tts === 'openai' ? 'gpt-4o-mini-tts' : 'tts-1', voice, input: text, speed, response_format: 'mp3' }),
      });
    } else {
      if (!env.xaiKey) return c.json({ error: 'Add a Grok (xAI) key in Settings › AI models.' }, 409);
      r = await fetch('https://api.x.ai/v1/tts', {
        method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.xaiKey}` },
        body: JSON.stringify({ text, voice_id: voice, language: 'auto', speed, output_format: { codec: 'mp3', sample_rate: 24000 } }),
      });
    }
  } catch (e: any) {
    return c.json({ error: `The voice did not answer: ${e?.message ?? e}` }, 502);
  }
  if (!r.ok) return c.json({ error: `The voice failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}` }, 502);
  return c.body(Buffer.from(await r.arrayBuffer()), 200, { 'Content-Type': r.headers.get('content-type') || 'audio/mpeg', 'Cache-Control': 'no-store' });
});

/** Turns a recording into text with the chosen engine. */
speechApi.post('/listen', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'recording too long' }, 413);
  if (file.size < 200) return c.json({ text: '' });
  const stt = currentChoice().stt;
  const ep = stt === 'groq' ? { url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: keyFor('groq'), model: 'whisper-large-v3-turbo' }
    : stt === 'openai' ? { url: 'https://api.openai.com/v1/audio/transcriptions', key: keyFor('openai'), model: 'whisper-1' }
    : stt === 'grok' ? { url: 'https://api.x.ai/v1/stt', key: env.xaiKey, model: process.env.XAI_STT_MODEL ?? 'grok-voice-transcribe-2.0' }
    : null;
  if (!ep) return c.json({ error: 'Speech is recognized on the device with this setting.' }, 400);
  if (!ep.key) return c.json({ error: 'The speech-to-text engine needs its key. Add it in Settings › AI models, or pick “This device” in Settings › Voice.' }, 409);
  const out = new FormData();
  out.append('model', ep.model);
  out.append('file', file, file.name || 'speech.webm');
  const r = await fetch(ep.url, { method: 'POST', headers: { authorization: `Bearer ${ep.key}` }, body: out, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!r?.ok) return c.json({ error: `Transcription failed${r ? ` (${r.status})` : ''}.` }, 502);
  const j = (await r.json()) as { text?: string };
  return c.json({ text: (j.text ?? '').trim() });
});
