import { spawn, execFileSync } from 'node:child_process';
import { env } from './env.js';
import { forgetEngine } from './native/localModels.js';
import { freellmapiSetupScript, startService, voiceSetupScript } from './services.js';
import { setAppSettings } from './env.js';

/**
 * One-tap setup from inside the app, for YakkBot running in Termux or on Linux: the commands are
 * fixed here, never taken from the request, and each job runs at most once at a time.
 */
export type JobId = 'engine' | 'desktop' | 'voice' | 'freellmapi';
interface Job { state: 'idle' | 'running' | 'done' | 'failed'; log: string; startedAt: number | null }
const fresh = (): Job => ({ state: 'idle', log: '', startedAt: null });
const jobs: Record<JobId, Job> = { engine: fresh(), desktop: fresh(), voice: fresh(), freellmapi: fresh() };

const has = (cmd: string) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

/** The shell script for a job on this system, or why it can't run here. */
function scriptFor(id: JobId): { script?: string; why?: string } {
  if (process.platform === 'win32') return { why: id === 'voice' ? 'On Windows run:  pip install edge-tts  then start YakkBot from WSL, or use another voice.' : 'Run install.ps1 again on Windows, or use WSL.' };
  if (id === 'voice') return { script: voiceSetupScript() };
  if (id === 'freellmapi') return { script: freellmapiSetupScript() };
  if (id === 'engine') {
    if (env.isTermux) return { script: 'pkg update -y && pkg install -y llama-cpp' };
    if (has('brew')) return { script: 'brew install llama.cpp' };
    if (has('apt-get') && process.getuid?.() === 0) return { script: 'apt-get update && (apt-get install -y llama.cpp || apt-get install -y llama-cpp)' };
    return { why: 'Install llama.cpp (llama-server) with your package manager, then restart YakkBot.' };
  }
  // The desktop: the YakkBot helper sets it up, starts it, and YakkBot restarts to pick it up.
  if (!has('yakkbot')) return { why: 'The yakkbot helper is not on the PATH; run the installer again.' };
  return { script: 'yakkbot desktop setup && yakkbot desktop start && echo "Restarting YakkBot to use the desktop…" && (sleep 2; yakkbot restart) >/dev/null 2>&1 &\nwait' };
}

export function jobStatus(id: JobId) {
  const j = jobs[id];
  const { why } = scriptFor(id);
  return { id, state: j.state, log: j.log.slice(-4000), startedAt: j.startedAt, available: !why, why: why ?? null };
}

export function startJob(id: JobId) {
  const j = jobs[id];
  if (j.state === 'running') return jobStatus(id);
  const { script, why } = scriptFor(id);
  if (!script) throw new Error(why);
  Object.assign(j, { state: 'running', log: `$ ${script.split('\n')[0]}\n`, startedAt: Date.now() });
  const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  const add = (b: Buffer) => { j.log = (j.log + b.toString()).slice(-20_000); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => { j.state = 'failed'; j.log += `\n${e.message}`; });
  child.on('close', (code) => {
    j.state = code === 0 ? 'done' : 'failed';
    j.log += code === 0 ? '\nFinished.' : `\nStopped with exit code ${code}.`;
    if (id === 'engine') forgetEngine();
    // A helper that installed fine is started right away, and again whenever YakkBot starts.
    if (code === 0 && (id === 'voice' || id === 'freellmapi')) {
      j.log += '\nStarting it…';
      setAppSettings(id === 'voice' ? { autostartVoice: true } : { autostartFreellmapi: true });
      void startService(id).then((r) => { j.log += `\n${r.message}`; if (!r.ok) j.state = 'failed'; });
    }
  });
  return jobStatus(id);
}
