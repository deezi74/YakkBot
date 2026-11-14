// Talk mode: a hands-free voice conversation with any bot on any model (cloud, FreeLLMAPI or a GGUF on
// the phone). Listen -> turn speech into text -> send it as a message -> wait for the reply -> read it
// aloud -> listen again. Which engines listen and speak is chosen in Settings › Voice.
import { create } from 'zustand';
import { api } from '../lib/api';
import { android } from '../lib/android';
import { useStore } from '../store';
import { micErrorMessage, openMic } from './audio';

export type TalkStatus = 'idle' | 'listening' | 'sending' | 'thinking' | 'speaking';
export interface SpeechSettings { tts: string; ttsVoice: string; stt: string; voiceMode: 'talk' | 'realtime' }

interface TalkState { status: TalkStatus; botId: string | null; heard: string; error: string | null; level: number }
export const useTalk = create<TalkState>(() => ({ status: 'idle', botId: null, heard: '', error: null, level: 0 }));

type Droid = typeof android & {
  speak?(text: string, rate: number): void; stopSpeaking?(): void; listen?(lang: string): void; stopListening?(): void;
};
const droid = android as Droid | undefined;
const w = window as unknown as Record<string, unknown>;

let run = 0; // bumps on stop, so an old loop notices and quits
let stopNow: (() => void) | null = null; // ends the current listen or speech early

export async function speechSettings(): Promise<SpeechSettings> {
  const r = await fetch('/api/speech/options', { credentials: 'include' });
  if (!r.ok) return { tts: 'device', ttsVoice: '', stt: 'device', voiceMode: 'talk' };
  return (await r.json()).settings;
}

export function startTalk(botId: string) {
  stopTalk();
  const my = ++run;
  useTalk.setState({ status: 'listening', botId, heard: '', error: null });
  void loop(botId, my);
}

export function stopTalk() {
  run++;
  stopNow?.();
  stopNow = null;
  droid?.stopSpeaking?.();
  droid?.stopListening?.();
  window.speechSynthesis?.cancel();
  useTalk.setState({ status: 'idle', botId: null, level: 0 });
}

/** While listening: send what was said now. While speaking: stop and listen again. */
export function talkTap() { stopNow?.(); }

async function loop(botId: string, my: number) {
  const alive = () => run === my;
  let s: SpeechSettings;
  try { s = await speechSettings(); } catch { s = { tts: 'device', ttsVoice: '', stt: 'device', voiceMode: 'talk' }; }
  const lang = useStore.getState().bots.find((b) => b.id === botId)?.voiceLanguage ?? 'auto';
  let empty = 0;
  while (alive()) {
    useTalk.setState({ status: 'listening', level: 0 });
    let text = '';
    try { text = (await listen(s.stt, lang, alive)).trim(); }
    catch (e) { if (alive()) useTalk.setState({ error: (e as Error).message, status: 'idle', botId: null }); run++; return; }
    if (!alive()) return;
    if (!text) { if (++empty >= 3) { stopTalk(); return; } continue; }
    empty = 0;
    useTalk.setState({ status: 'sending', heard: text });
    let seq = 0;
    try { seq = (await api.send(botId, text)).row.seq; }
    catch (e) { useTalk.setState({ error: (e as Error).message }); stopTalk(); return; }
    useTalk.setState({ status: 'thinking' });
    const reply = await waitForReply(botId, seq, alive);
    if (!alive()) return;
    if (reply) {
      useTalk.setState({ status: 'speaking' });
      try { await speak(s, reply, alive); }
      catch (e) { if (alive()) useTalk.setState({ error: (e as Error).message }); }
    }
  }
}

// ---------- waiting for the bot ----------

function replyAfter(botId: string, seq: number): { text: string; done: boolean } {
  const st = useStore.getState();
  const rows = Object.values(st.transcripts[botId]?.bySeq ?? {}).filter((r) => r.seq > seq).sort((a, b) => a.seq - b.seq);
  const msgs = rows.filter((r) => r.kind === 'message' && (r.body as any).role === 'assistant');
  const streaming = msgs.some((r) => (r.body as any).streaming);
  const text = msgs.map((r) => String((r.body as any).text ?? '')).join('\n\n').trim();
  const running = !!st.live[botId]?.isRunning;
  return { text, done: !running && !streaming && (text.length > 0 || rows.some((r) => r.kind === 'notice')) };
}

function waitForReply(botId: string, seq: number, alive: () => boolean): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (!alive()) return finish('');
      const r = replyAfter(botId, seq);
      if (r.done) finish(r.text);
      else if (Date.now() - started > 10 * 60_000) finish(r.text);
    };
    const unsub = useStore.subscribe(check);
    const timer = setInterval(check, 1000);
    function finish(t: string) { unsub(); clearInterval(timer); resolve(t); }
    check();
  });
}

// ---------- listening ----------

function listen(stt: string, lang: string, alive: () => boolean): Promise<string> {
  if (stt === 'device') {
    if (droid?.listen) return listenAndroid(lang);
    const C = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (C) return listenBrowser(C, lang);
    // No recognizer here: record and let the server try.
  }
  return listenRecorded(alive);
}

function listenAndroid(lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    w.__yakkHeard = (t: string) => { stopNow = null; resolve(t ?? ''); };
    w.__yakkHeardError = (m: string) => { stopNow = null; reject(new Error(m)); };
    stopNow = () => droid?.stopListening?.();
    droid!.listen!(lang);
  });
}

function listenBrowser(C: any, lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new C();
    r.lang = lang && lang !== 'auto' ? lang : navigator.language;
    r.continuous = false;
    r.interimResults = false;
    let text = '';
    r.onresult = (e: any) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += ` ${e.results[i][0].transcript}`; };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') reject(new Error('Allow the microphone to talk.'));
    };
    r.onend = () => { stopNow = null; resolve(text.trim()); };
    stopNow = () => r.stop();
    r.start();
  });
}

/** Records until you stop talking (about a second of quiet), then transcribes on the server. */
async function listenRecorded(alive: () => boolean): Promise<string> {
  let stream: MediaStream;
  try { stream = await openMic(); } catch (e) { throw new Error(micErrorMessage(e)); }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m));
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  const blob = await new Promise<Blob>((resolve) => {
    let spoke = false, quietSince = 0;
    const started = Date.now();
    const done = () => { clearInterval(t); if (mr.state !== 'inactive') mr.stop(); };
    mr.onstop = () => resolve(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
    stopNow = done;
    const t = setInterval(() => {
      if (!alive()) return done();
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      useTalk.setState({ level: Math.min(1, rms * 8) });
      const now = Date.now();
      if (rms > 0.03) { spoke = true; quietSince = 0; }
      else if (spoke && !quietSince) quietSince = now;
      if ((spoke && quietSince && now - quietSince > 1200) || now - started > 60_000 || (!spoke && now - started > 15_000)) done();
    }, 80);
    mr.start(250);
  });
  stopNow = null;
  stream.getTracks().forEach((tr) => tr.stop());
  void ctx.close();
  if (!alive() || blob.size < 1500) return '';
  useTalk.setState({ status: 'sending', level: 0 });
  const fd = new FormData();
  fd.append('file', blob, `speech.${(mr.mimeType || 'audio/webm').includes('mp4') ? 'mp4' : 'webm'}`);
  const r = await fetch('/api/speech/listen', { method: 'POST', credentials: 'include', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'Transcription failed.');
  return String(j.text ?? '');
}

// ---------- speaking ----------

const plain = (t: string) => t.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, 'a link').replace(/[*_#>`|]/g, '').replace(/\s+/g, ' ').trim();

export async function speak(s: Pick<SpeechSettings, 'tts' | 'ttsVoice'>, text: string, alive: () => boolean = () => true, speed = 1): Promise<void> {
  if (s.tts === 'device') {
    if (droid?.speak) {
      await new Promise<void>((resolve, reject) => {
        w.__yakkSpoken = (err?: string) => { stopNow = null; err ? reject(new Error(err)) : resolve(); };
        stopNow = () => { droid?.stopSpeaking?.(); resolve(); };
        droid.speak!(plain(text), speed);
      });
      return;
    }
    if (!window.speechSynthesis) throw new Error('This browser has no voice. Pick another one in Settings › Voice.');
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(plain(text));
      u.rate = speed;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      stopNow = () => { window.speechSynthesis.cancel(); resolve(); };
      window.speechSynthesis.speak(u);
    });
    stopNow = null;
    return;
  }
  const r = await fetch('/api/speech/speak', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, tts: s.tts, voice: s.ttsVoice, speed }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'The voice failed.');
  if (!alive()) return;
  const url = URL.createObjectURL(await r.blob());
  const audio = new Audio(url);
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    stopNow = () => { audio.pause(); resolve(); };
    audio.play().catch(() => resolve());
  });
  stopNow = null;
  URL.revokeObjectURL(url);
}
