import type { Bot, ComputerState, EngineInfo, EngineProvider, LibraryFile, Memory, Routine, Skill, Task, Toolkit } from '@shared/types';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
}

export interface Connection { id: string; kind: 'bot' | 'person'; otherBotId: string | null; name: string; relation: string; note: string; createdAt: number }

export interface SetupJob { id: string; state: 'idle' | 'running' | 'done' | 'failed'; log: string; startedAt: number | null; available: boolean; why: string | null }

export interface ComputerSetup {
  mode: 'none' | 'local' | 'orgo';
  maxBots: number;
  orgo: { hasKey: boolean; computerId: string; computerName: string };
  local: { available: boolean; app: boolean; termux: boolean };
}
export interface OrgoWorkspace { id: string; name: string; computers: { id: string; name: string; status: string }[] }

export interface HomeFileInfo { key: 'soul' | 'memory' | 'user'; title: string; limit: number; text: string }

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode'>>;

export const configApi = {
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  setupJob: (job: 'engine' | 'desktop') => req<SetupJob>('GET', `/setup/${job}`),
  startSetupJob: (job: 'engine' | 'desktop') => req<SetupJob>('POST', `/setup/${job}`),
  connections: (botId: string) => req<{ connections: Connection[] }>('GET', `/bots/${botId}/connections`).then((r) => r.connections),
  addConnection: (botId: string, c: { kind: 'bot' | 'person'; otherBotId?: string; name?: string; relation?: string; note?: string }) => req<{ connections: Connection[] }>('POST', `/bots/${botId}/connections`, c).then((r) => r.connections),
  removeConnection: (botId: string, id: string) => req<{ connections: Connection[] }>('DELETE', `/bots/${botId}/connections/${id}`).then((r) => r.connections),
  computerSetup: () => req<ComputerSetup>('GET', '/computer/setup'),
  orgoKey: (key?: string) => req<{ workspaces: OrgoWorkspace[] }>('POST', '/computer/orgo/key', { key }),
  orgoUse: (computerId: string, name: string) => req<{ ok: true }>('POST', '/computer/orgo/use', { computerId, name }),
  orgoCreate: (workspaceId: string) => req<{ ok: true; computerId: string }>('POST', '/computer/orgo/create', { workspaceId }),
  orgoForget: () => req<{ ok: true }>('POST', '/computer/orgo/forget'),
  computerMode: (mode: 'none' | 'local' | 'orgo') => req<{ ok: true }>('POST', '/computer/mode', { mode }),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
  /** Tells the bot the person has stopped driving its screen. */
  handback: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/handback`),

  engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
  setEngine: (botId: string, p: { provider?: string | null; model?: string | null }) => req<{ engine: EngineInfo }>('PATCH', `/bots/${botId}/engine`, p),
  /** Opens the provider's sign-in flow in a terminal on the bot's screen. */
  engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
  restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private screen the agent runs for itself, so its computer work shows on the screen in the app. */
  stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),

  /** Built-in engine: model keys are kept on the device and shared by every bot. */
  setProvider: (id: string, p: { apiKey?: string | null; baseUrl?: string | null; defaultModel?: string | null }) => req<{ providers: EngineProvider[] }>('PUT', `/providers/${id}`, p),
  removeProvider: (id: string) => req<{ providers: EngineProvider[] }>('DELETE', `/providers/${id}`),

  /** The bot's soul and memory files, as text. */
  home: (botId: string) => req<{ editable: boolean; files: HomeFileInfo[] }>('GET', `/bots/${botId}/home`),
  saveHome: (botId: string, key: string, text: string) => req<{ ok: true }>('PUT', `/bots/${botId}/home/${key}`, { text }),

  /** The YakkBot Android app's phone bridge. */
  device: () => req<{ paired: boolean; reachable: boolean; info: Record<string, unknown> | null }>('GET', '/device'),
  unpairDevice: () => req<{ paired: boolean }>('DELETE', '/device'),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};
