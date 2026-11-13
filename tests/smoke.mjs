// End-to-end check of the built-in engine against the mock model server. No real provider is called.
//   node tests/smoke.mjs            starts the mock + a throwaway server, runs the checks, cleans up
// Needs a built server (npm run build).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yakk-smoke-'));
const PORT = 18787, MOCK = 18799;
const base = `http://127.0.0.1:${PORT}`;
const procs = [];
const start = (args, env) => {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  procs.push(p);
  return p;
};
const cleanup = () => { for (const p of procs) p.kill(); fs.rmSync(home, { recursive: true, force: true }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function api(method, p, body) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failed++; };

async function rows(botId) { return (await api('GET', `/bots/${botId}/rows`)).json.rows; }
async function settle(botId, pred, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const rs = await rows(botId);
    if (pred(rs)) return rs;
    if (Date.now() - t0 > ms) return rs;
    await sleep(150);
  }
}
const lastAssistant = (rs) => rs.filter((r) => r.kind === 'message' && r.body.role === 'assistant' && !r.body.streaming).pop()?.body.text;

async function run(wire) {
  console.log(`\n== ${wire} wire ==`);
  const env = { YAKK_HOME: path.join(home, wire), PORT: String(PORT), YAKK_PASSWORD: 'correct horse', NODE_NO_WARNINGS: '1' };
  if (wire === 'openai') Object.assign(env, { CUSTOM_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, CUSTOM_MODEL: 'mock-1' });
  else Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}`, ANTHROPIC_API_KEY: 'sk-ant-test' });
  const server = start([path.join(root, 'server/dist/index.js')], env);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ } await sleep(200); }
  cookie = '';

  check('unauthenticated request is refused', (await api('GET', '/bots')).status === 401);
  check('wrong passphrase is refused', (await api('POST', '/auth/password', { password: 'nope' })).status === 401);
  check('passphrase signs in', (await api('POST', '/auth/password', { password: 'correct horse' })).status === 200);
  const { bots } = (await api('GET', '/bots')).json;
  check('a first bot exists', bots?.length === 1 && bots[0].isPrimary, JSON.stringify(bots));
  const bot = bots[0];

  const eng = (await api('GET', `/bots/${bot.id}/engine`)).json.engine;
  check('engine is ready on the built-in loop', eng.kind === 'native' && eng.status === 'ready', JSON.stringify(eng).slice(0, 300));

  await api('POST', `/bots/${bot.id}/messages`, { text: 'hello there' });
  let rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('You said'));
  check('plain reply streams into the transcript', lastAssistant(rs) === 'You said: hello there', lastAssistant(rs));

  await api('POST', `/bots/${bot.id}/messages`, { text: 'run: echo yakk-$((6*7)) > note.txt && cat note.txt' });
  rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('Tool said'));
  check('shell tool ran and its output came back', lastAssistant(rs) === 'Tool said: yakk-42', lastAssistant(rs));
  const tool = rs.find((r) => r.kind === 'tool-call' && r.body.name === 'terminal');
  check('tool call row is marked done', tool?.body.status === 'done', JSON.stringify(tool?.body));
  const files = (await api('GET', `/bots/${bot.id}/files`)).json;
  check('the file shows up in the Library', files.files?.some((f) => f.name === 'note.txt'), JSON.stringify(files));

  await api('POST', `/bots/${bot.id}/messages`, { text: 'remember: likes short answers' });
  rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('Tool said: Saved'));
  const mem = (await api('GET', `/bots/${bot.id}/memories`)).json.memories;
  check('memory tool wrote a note', mem?.some((m) => m.text === 'likes short answers'), JSON.stringify(mem));
  const homeFiles = (await api('GET', `/bots/${bot.id}/home`)).json;
  check('soul and memory files are readable', homeFiles.files?.find((f) => f.key === 'user')?.text.includes('likes short answers') && homeFiles.files?.find((f) => f.key === 'soul')?.text.length > 20);
  check('soul file can be edited', (await api('PUT', `/bots/${bot.id}/home/soul`, { text: '# Soul\nYou are terse.' })).status === 200);

  // A risky command waits for approval; denying it returns a refusal to the model.
  await api('POST', `/bots/${bot.id}/messages`, { text: 'run: rm -rf ./nothing-here' });
  rs = await settle(bot.id, (r) => r.some((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending'));
  const card = rs.find((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending');
  check('risky shell command asks first', !!card, JSON.stringify(rs.slice(-3).map((r) => r.body)));
  if (card) {
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'deny' });
    rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('Tool said: The user declined'));
    check('a denied command does not run', lastAssistant(rs)?.startsWith('Tool said: The user declined'), lastAssistant(rs));
  }

  await api('POST', `/bots/${bot.id}/messages`, { text: 'ask: Ship it?' });
  rs = await settle(bot.id, (r) => r.some((x) => x.kind === 'card' && x.body.card === 'question'));
  check('ask_user shows a question card and ends the turn', rs.some((x) => x.kind === 'card' && x.body.card === 'question' && x.body.question === 'Ship it?'));

  const second = (await api('POST', '/bots', { name: 'Scout', mode: 'personal' })).json.bot;
  check('a second bot can be created', second?.name === 'Scout');
  await api('POST', `/bots/${second.id}/messages`, { text: 'ping' });
  rs = await settle(second.id, (r) => !!lastAssistant(r));
  check('the second bot answers on its own thread', lastAssistant(rs) === 'You said: ping', lastAssistant(rs));
  check('deleting a bot works', (await api('DELETE', `/bots/${second.id}`)).status === 200);

  const mcp = await fetch(`${base}/mcp/${bot.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('MCP endpoint refuses a caller without the token', mcp.status === 401);

  server.kill();
  await sleep(400);
}

try {
  start([path.join(root, 'tests/mock-llm.mjs'), String(MOCK)], {});
  await sleep(500);
  await run('openai');
  await run('anthropic');
} catch (e) {
  console.error(e);
  failed++;
} finally {
  cleanup();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
