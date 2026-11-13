import { Hono } from 'hono';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { env } from './env.js';
import { emitBot, getBotRow, listRoutines, listTasks } from './store.js';
import { computerState, readyScreen, resetBotScreen } from './computer.js';
import { box } from './box.js';
import { orgo } from './orgo.js';
import { openTerminal } from './desk.js';
import path from 'node:path';
import { engineHome, engineInfo, engineKind, forgetEngineOptions, restartEngine, stopOwnScreen } from './engine.js';
import { MEMORY_LIMIT, USER_LIMIT, readHomeFile, writeHomeFile, type HomeFile } from './native/home.js';
import { PROVIDERS, listProviders, removeProviderKey, setProviderKey } from './native/providers.js';
import { listMemories } from './engine-memory.js';
import { idleConfig, viewerCount } from './idle.js';
import type { LibraryFile, Skill } from './types.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*', '/providers', '/providers/*']) configApi.use(p, requireUser);

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

const toSkill = (s: any): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map(toSkill);

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({
    memories: listMemories(b.id),
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    // The agent keeps its own memory and trims its own context; there is nothing for the app to maintain.
    memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 0, lastCompaction: null },
  });
});

// ---------- skills ----------

function cleanSkill(p: any, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id)) });
});

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as any;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id)) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
});

// ---------- memory maintenance (now the agent's own job; kept so older clients get an answer) ----------

configApi.post('/bots/:id/memories/consolidate', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ added: [], skipped: 0, considered: 0 });
});

configApi.post('/bots/:id/compact', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ itemsBefore: 0, itemsAfter: 0, compacted: false });
});

// ---------- the agent behind a bot: model, sign-in, restart ----------

configApi.get('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ engine: await engineInfo(b.id) });
});

/** Which model this bot's turns ask for. Empty values go back to the agent's own default. */
configApi.patch('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json<{ provider?: string | null; model?: string | null }>().catch(() => ({} as { provider?: string | null; model?: string | null }));
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  if (p.provider !== undefined) db.prepare('UPDATE bots SET provider=?, updated_at=? WHERE id=?').run(clean(p.provider), now(), b.id);
  if (p.model !== undefined) db.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(clean(p.model), now(), b.id);
  emitBot(b.id);
  return c.json({ engine: await engineInfo(b.id) });
});

/**
 * Sign in to a model provider (a Claude, ChatGPT or Grok subscription, or an API key). Hermes does
 * the sign-in itself; we open its command in a terminal on the bot's screen, where the user
 * finishes it through the live view.
 */
configApi.post('/bots/:id/engine/login', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (engineKind(b.id) === 'native') return c.json({ error: 'This bot runs on the built-in engine: add an API key in the Engine panel instead.' }, 409);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This bot has no agent.' }, 409);
  // The agent's files are on the machine this server runs on; a terminal on another machine cannot reach them.
  if (!box.local) return c.json({ error: 'Sign-in opens a terminal on the computer. It works once the app runs on that computer.' }, 409);
  const { provider } = await c.req.json<{ provider?: string }>().catch(() => ({} as { provider?: string }));
  if (provider !== undefined && !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(provider)) return c.json({ error: 'bad provider' }, 400);
  const hermes = `HERMES_HOME=${box.quote(home)} ${box.quote(env.hermesBin)}`;
  // Claude subscriptions sign in with OAuth; without the flag Hermes asks for an API key.
  const cmd = !provider ? `${hermes} model` : `${hermes} auth add ${provider}${provider === 'anthropic' ? ' --type oauth' : ''}`;
  try {
    const s = await readyScreen(user.id, b.id);
    await openTerminal(s.screenId, cmd, provider ? `Sign in: ${provider}` : 'Choose a model');
    forgetEngineOptions(b.id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.post('/bots/:id/engine/restart', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  // The primary agent serves more than this app (its messaging runs through the same process), so it is never restarted from here.
  if (engineKind(b.id) === 'native') return c.json({ engine: await engineInfo(b.id) });
  if (engineKind(b.id) !== 'managed') return c.json({ error: `${b.name} runs on the computer's own agent, which this app does not restart.` }, 409);
  try {
    await restartEngine(b.id);
    forgetEngineOptions(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

/** Stop the private screen Hermes runs for this agent, so its computer work comes back to the screen shown here. */
configApi.post('/bots/:id/engine/screen/stop', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await stopOwnScreen(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 409);
  }
});

/** The user gives the screen back after taking control; the bot is told on its next turn. */
configApi.post('/bots/:id/handback', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET handback_at=? WHERE id=?').run(now(), b.id);
  return c.json({ ok: true });
});

// ---------- library: files under <LIBRARY_ROOT>/<botId> ----------

const LIB_ROOT = env.libraryRoot;

function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  try {
    if (box.local) {
      const root = path.join(LIB_ROOT, b.id);
      fs.mkdirSync(root, { recursive: true });
      const dirPath = path.join(root, rel);
      if (!fs.existsSync(dirPath)) return c.json({ status: 'error', path: rel, files: [], error: 'No such folder' });
      const files: LibraryFile[] = fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((d) => {
        try {
          const st = fs.statSync(path.join(dirPath, d.name));
          return [{ name: d.name, size: st.size, modifiedAt: st.mtimeMs, isDir: st.isDirectory() }];
        } catch { return []; }
      });
      files.sort((x, y) => Number(y.isDir) - Number(x.isDir) || y.modifiedAt - x.modifiedAt);
      return c.json({ status: 'ok', path: rel, files: files.slice(0, 1000) });
    }
    if (computerState(user.id).status !== 'running') return c.json({ status: 'asleep', path: rel, files: [] });
    const dir = `${LIB_ROOT}/${b.id}${rel ? `/${rel}` : ''}`;
    const r = await box.bash(`mkdir -p ${shq(`${LIB_ROOT}/${b.id}`)} && ls -la --time-style=+%s ${shq(dir)} 2>&1`, 30);
    if (r.exit_code !== 0) return c.json({ status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) });
    return c.json({ status: 'ok', path: rel, files: parseLs(r.output ?? '') });
  } catch (e: any) {
    return c.json({ status: 'error', path: rel, files: [], error: String(e?.message ?? e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await c.req.json<{ path: string }>().catch(() => ({ path: '' }));
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  // On the computer itself the file is on our own disk: serve it directly.
  if (box.local) return c.json({ url: `/api/bots/${b.id}/files/raw?path=${encodeURIComponent(rel)}` });
  try {
    if (!env.orgoComputerId) return c.json({ error: 'computer unavailable' }, 409);
    const r: any = await orgo.exportFile(env.orgoComputerId, `${LIB_ROOT}/${b.id}/${rel}`);
    const url = r?.url ?? r?.file?.url ?? r?.download_url;
    if (!url) return c.json({ error: 'export returned no link' }, 502);
    return c.json({ url });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.get('/bots/:id/files/raw', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  const root = `${LIB_ROOT}/${b.id}`;
  let file: string;
  try {
    // Follow links before checking, so a link inside the library cannot point outside it.
    file = fs.realpathSync(path.join(root, rel));
    if (!file.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(file).isFile()) throw new Error('outside');
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  const name = rel.split('/').pop()!;
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(fs.statSync(file).size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
});

// ---------- computer: screens, reset, hibernation ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const leases = db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at DESC').all(userId) as any[];
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
  });
});

/** Give a bot a clean screen: close what is open and bring its browser back to its home screen. Logins stay. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await resetBotScreen(user.id, b.id);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

// ---------- soul and memory files (the bot's persona and notes, editable as text) ----------

const HOME_FILES: Record<HomeFile, { title: string; limit: number }> = {
  soul: { title: 'Soul', limit: 20_000 },
  memory: { title: 'Memory', limit: MEMORY_LIMIT },
  user: { title: 'About you', limit: USER_LIMIT },
};

configApi.get('/bots/:id/home', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This bot has no agent.' }, 409);
  // The first bot on the Hermes engine is somebody's own agent: its files are shown, not edited from here.
  const editable = engineKind(b.id) !== 'primary';
  return c.json({ editable, files: (Object.keys(HOME_FILES) as HomeFile[]).map((k) => ({ key: k, ...HOME_FILES[k], text: readHomeFile(home, k) })) });
});

configApi.put('/bots/:id/home/:file', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const key = c.req.param('file') as HomeFile;
  if (!HOME_FILES[key]) return c.json({ error: 'unknown file' }, 400);
  if (engineKind(b.id) === 'primary') return c.json({ error: `${b.name} is the computer's own agent; edit its files in its Hermes home.` }, 409);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This bot has no agent.' }, 409);
  const { text } = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  if (typeof text !== 'string') return c.json({ error: 'text required' }, 400);
  if (text.length > HOME_FILES[key].limit) return c.json({ error: `Too long: ${text.length} characters, the limit is ${HOME_FILES[key].limit}.` }, 400);
  writeHomeFile(home, key, text);
  if (key !== 'soul') hub.emit(user.id, { type: 'memories', botId: b.id });
  return c.json({ ok: true });
});

// ---------- model providers of the built-in engine ----------

configApi.get('/providers', async (c) => c.json({ providers: await listProviders() }));

configApi.put('/providers/:id', async (c) => {
  const id = c.req.param('id');
  if (!PROVIDERS.some((p) => p.id === id)) return c.json({ error: 'unknown provider' }, 404);
  const p = await c.req.json<{ apiKey?: string | null; baseUrl?: string | null; defaultModel?: string | null }>().catch(() => ({} as any));
  try {
    setProviderKey(id, { apiKey: p.apiKey, baseUrl: p.baseUrl, defaultModel: p.defaultModel });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 400);
  }
  return c.json({ providers: await listProviders() });
});

configApi.delete('/providers/:id', async (c) => {
  removeProviderKey(c.req.param('id'));
  return c.json({ providers: await listProviders() });
});
