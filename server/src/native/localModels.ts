import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../env.js';

/**
 * GGUF models on this device, run offline by llama.cpp's `llama-server` (Termux: `pkg install llama-cpp`;
 * a PC: install llama.cpp). The server downloads them from Hugging Face into <YAKK_HOME>/models and
 * starts llama-server with the one a bot picked. The YakkBot Android app has its own copy of this
 * (it ships llama-server inside the APK); see device.ts for that path.
 */

export const LOCAL_PORT = Number(process.env.YAKK_MODEL_PORT ?? 8081);
export const modelsDir = path.join(env.dataDir, 'models');

/** id, name, maker, repo, file, bytes, min RAM (GB), tag, note. From D-Agent's list (sizes checked 2026-11-02). */
export const CATALOG = [
  { id: 'lfm25-1.2b', name: 'LFM2.5 1.2B Instruct', maker: 'Liquid AI', repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF', file: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf', bytes: 730_895_168, minRamGb: 3, tag: 'Fastest', note: 'Built for phones: replies very fast on the CPU and handles simple tools.' },
  { id: 'qwen35-0.8b', name: 'Qwen3.5 0.8B', maker: 'Qwen', repo: 'bartowski/Qwen_Qwen3.5-0.8B-GGUF', file: 'Qwen_Qwen3.5-0.8B-Q4_K_M.gguf', bytes: 579_615_840, minRamGb: 3, tag: 'Tiny', note: 'The smallest of the 2026 Qwen family. Runs on any phone.' },
  { id: 'qwen35-2b', name: 'Qwen3.5 2B', maker: 'Qwen', repo: 'bartowski/Qwen_Qwen3.5-2B-GGUF', file: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf', bytes: 1_396_198_496, minRamGb: 4, tag: 'Best balance', note: 'The best pick for most phones: reliable with tools, web search and phone controls.' },
  { id: 'lfm25-2.6b', name: 'LFM2.5 2.6B', maker: 'Liquid AI', repo: 'LiquidAI/LFM2.5-2.6B-GGUF', file: 'LFM2.5-2.6B-Q4_K_M.gguf', bytes: 1_674_455_040, minRamGb: 4, tag: 'Quick agent', note: 'Fast like the 1.2B but noticeably smarter.' },
  { id: 'gemma4-e2b', name: 'Gemma 4 E2B', maker: 'Google', repo: 'bartowski/google_gemma-4-E2B-it-GGUF', file: 'google_gemma-4-E2B-it-Q4_K_M.gguf', bytes: 3_462_680_032, minRamGb: 6, tag: 'Natural writer', note: "Google's 2026 phone model with built-in tool calling." },
  { id: 'qwen35-4b', name: 'Qwen3.5 4B', maker: 'Qwen', repo: 'bartowski/Qwen_Qwen3.5-4B-GGUF', file: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf', bytes: 3_013_027_808, minRamGb: 8, tag: 'Smartest for 8 GB', note: 'Much stronger research and planning. Best with 8 GB of RAM or more.' },
  { id: 'nemotron-bolt-e4b', name: 'Nemotron 3.5 Bolt E4B', maker: 'NVIDIA', repo: 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF', file: 'NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf', bytes: 5_060_482_240, minRamGb: 8, tag: 'Best tool user', note: 'Tuned for fast, multi-step tool use. Needs 8 GB of RAM or more.' },
  { id: 'gemma4-e4b', name: 'Gemma 4 E4B', maker: 'Google', repo: 'bartowski/google_gemma-4-E4B-it-GGUF', file: 'google_gemma-4-E4B-it-Q4_K_M.gguf', bytes: 5_405_170_144, minRamGb: 8, tag: 'Best writing', note: 'The most natural chat and writing of these.' },
  { id: 'qwen35-9b', name: 'Qwen3.5 9B', maker: 'Qwen', repo: 'bartowski/Qwen_Qwen3.5-9B-GGUF', file: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf', bytes: 6_169_341_984, minRamGb: 12, tag: 'Flagship only', note: 'Closest to a cloud model. Needs 12 GB of RAM and patience.' },
];

const ramGb = () => os.totalmem() / 1e9;
const recommended = () => (ramGb() >= 7.5 ? 'qwen35-4b' : ramGb() >= 3.6 ? 'qwen35-2b' : 'lfm25-1.2b');

let engineBin: string | null | undefined;
/** The llama-server program: LLAMA_SERVER, or on the PATH. */
export function engine(): string | null {
  if (engineBin !== undefined) return engineBin;
  const want = process.env.LLAMA_SERVER || 'llama-server';
  try {
    engineBin = path.isAbsolute(want) ? (fs.existsSync(want) ? want : null) : execFileSync(process.platform === 'win32' ? 'where' : 'which', [want], { encoding: 'utf8' }).split('\n')[0].trim() || null;
  } catch { engineBin = null; }
  return engineBin;
}
export const forgetEngine = () => { engineBin = undefined; };

// ---------- downloads ----------

interface Download { file: string; done: number; total: number; failed: boolean; error?: string; ctrl: AbortController }
const downloads = new Map<string, Download>();

const safeName = (f: string) => /^[\w.+-]+\.gguf$/i.test(f) && !f.includes('..');

export function startDownload(url: string, file: string) {
  if (!url.startsWith('https://huggingface.co/')) throw new Error('Models download from huggingface.co only.');
  if (!safeName(file)) throw new Error('Not a .gguf file name.');
  fs.mkdirSync(modelsDir, { recursive: true });
  if (fs.existsSync(path.join(modelsDir, file))) throw new Error(`${file} is already downloaded.`);
  if (downloads.get(file) && !downloads.get(file)!.failed) return;
  const d: Download = { file, done: 0, total: 0, failed: false, ctrl: new AbortController() };
  downloads.set(file, d);
  const part = path.join(modelsDir, `${file}.part`);
  void (async () => {
    try {
      const r = await fetch(url, { signal: d.ctrl.signal, headers: { 'user-agent': 'YakkBot' } });
      if (!r.ok || !r.body) throw new Error(`Hugging Face answered HTTP ${r.status}`);
      d.total = Number(r.headers.get('content-length') ?? 0);
      const body = Readable.fromWeb(r.body as any);
      body.on('data', (chunk: Buffer) => { d.done += chunk.length; });
      await pipeline(body, fs.createWriteStream(part));
      fs.renameSync(part, path.join(modelsDir, file));
      downloads.delete(file);
    } catch (e: any) {
      fs.rmSync(part, { force: true });
      if (d.ctrl.signal.aborted) { downloads.delete(file); return; }
      d.failed = true;
      d.error = String(e?.message ?? e);
    }
  })();
}

export function cancelDownload(file: string) {
  const d = downloads.get(file);
  if (d) { d.ctrl.abort(); downloads.delete(file); }
  fs.rmSync(path.join(modelsDir, `${file}.part`), { force: true });
}

export function deleteModel(file: string) {
  if (!safeName(file)) throw new Error('Not a model file.');
  if (running?.file === file) stopModel();
  fs.rmSync(path.join(modelsDir, file), { force: true });
}

export function installedModels(): { file: string; bytes: number }[] {
  try {
    return fs.readdirSync(modelsDir).filter((f) => f.endsWith('.gguf')).map((f) => ({ file: f, bytes: fs.statSync(path.join(modelsDir, f)).size }));
  } catch { return []; }
}

// ---------- Hugging Face ----------

export async function searchHub(q: string) {
  const r = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(q.trim())}&filter=gguf&sort=downloads&direction=-1&limit=25`, { headers: { 'user-agent': 'YakkBot' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Hugging Face answered HTTP ${r.status}`);
  return ((await r.json()) as any[]).map((m) => ({ repo: String(m.id ?? m.modelId), downloads: Number(m.downloads ?? 0), likes: Number(m.likes ?? 0) }));
}

export async function hubFiles(repoOrUrl: string) {
  const parts = repoOrUrl.trim().replace(/^https?:\/\//, '').replace(/^huggingface\.co\//, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Use owner/name, like bartowski/Qwen_Qwen3.5-2B-GGUF');
  const repo = `${parts[0]}/${parts[1]}`;
  const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { headers: { 'user-agent': 'YakkBot' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Hugging Face answered HTTP ${r.status}`);
  return ((await r.json()) as any[])
    .filter((f) => typeof f.path === 'string' && /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path))
    .map((f) => ({ repo, path: f.path as string, file: (f.path as string).split('/').pop()!, bytes: Number(f.lfs?.size ?? f.size ?? 0), url: `https://huggingface.co/${repo}/resolve/main/${f.path}` }))
    .sort((a, b) => a.bytes - b.bytes);
}

// ---------- running one ----------

let running: { file: string; proc: ChildProcess } | null = null;
let state: { state: 'stopped' | 'starting' | 'running' | 'failed'; error?: string } = { state: 'stopped' };
let starting: Promise<void> | null = null;
const logFile = path.join(env.dataDir, 'llama-server.log');

const healthy = () => fetch(`http://127.0.0.1:${LOCAL_PORT}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

export function stopModel() {
  running?.proc.kill();
  running = null;
  state = { state: 'stopped' };
}

/** Starts llama-server with this model unless it already runs it, and waits until it answers. */
export function useModel(file: string, ctx = 12288): Promise<void> {
  if (running?.file === file && running.proc.exitCode === null && state.state === 'running') return healthy().then((ok) => (ok ? undefined : restart()));
  if (starting) return starting.then(() => useModel(file, ctx));
  const restart = () => { stopModel(); return useModel(file, ctx); };
  starting = (async () => {
    const bin = engine();
    if (!bin) throw new Error(env.isTermux ? 'The model engine is not installed. In Termux run: pkg install llama-cpp' : 'The model engine (llama-server from llama.cpp) is not installed or not on the PATH.');
    const model = path.join(modelsDir, file);
    if (!safeName(file) || !fs.existsSync(model)) throw new Error(`The model ${file} is not downloaded. Download it in Settings > On-device models.`);
    stopModel();
    state = { state: 'starting' };
    const threads = Math.max(2, Math.min(6, os.cpus().length - 2));
    const args = ['-m', model, '--host', '127.0.0.1', '--port', String(LOCAL_PORT), '-c', String(ctx), '-t', String(threads), '--jinja', '-np', '1', '-a', file];
    const out = fs.openSync(logFile, 'w');
    const proc = spawn(bin, args, { stdio: ['ignore', out, out] });
    fs.closeSync(out);
    running = { file, proc };
    let exited = false;
    proc.on('exit', () => { exited = true; if (running?.proc === proc) { running = null; if (state.state === 'running') state = { state: 'stopped' }; } });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      if (exited) {
        const tail = fs.readFileSync(logFile, 'utf8').slice(-600);
        state = { state: 'failed', error: tail || 'The model engine stopped.' };
        throw new Error(`The model could not start (often: not enough free memory; try a smaller one). ${tail.slice(-300)}`);
      }
      if (await healthy()) { state = { state: 'running' }; return; }
    }
    stopModel();
    state = { state: 'failed', error: 'Timed out loading the model.' };
    throw new Error('The model took too long to load. Try a smaller one.');
  })().finally(() => { starting = null; });
  return starting;
}

export function localStatus() {
  return {
    engine: !!engine(),
    engineHint: engine() ? null : env.isTermux ? 'pkg install llama-cpp' : 'install llama.cpp (llama-server)',
    ramGb: Math.round(ramGb() * 10) / 10,
    recommended: recommended(),
    state: state.state,
    running: running?.file ?? '',
    ...(state.error ? { error: state.error } : {}),
    catalog: CATALOG.map((m) => ({ ...m, fits: ramGb() >= m.minRamGb - 0.5 })),
    installed: installedModels(),
    downloads: [...downloads.values()].map(({ ctrl: _c, ...d }) => d),
  };
}
