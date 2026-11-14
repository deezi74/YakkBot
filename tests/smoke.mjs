// End-to-end check of the built-in engine against the mock model server. No real provider is called.
//   node tests/smoke.mjs            starts the mock + a throwaway server, runs the checks, cleans up
// Needs a built server (npm run build).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yakk-smoke-'));
const PORT = 18787, MOCK = 18799, BRIDGE = 18765;
const BRIDGE_TOKEN = 'ab'.repeat(32);
const bridgeCalls = [];
// Stands in for the Android app's phone bridge.
const fakeBridge = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) return send(401, { error: 'unauthorized' });
    bridgeCalls.push({ path: req.url, body: JSON.parse(raw || '{}') });
    if (req.url === '/status') return send(200, { ok: true, screenControl: true, phone: true });
    if (req.url === '/models/status') return send(200, { engine: true, ramGb: 8, recommended: 'qwen35-2b', state: 'stopped', running: '', catalog: [], installed: [{ file: 'tiny.gguf', bytes: 1000 }], downloads: [] });
    if (req.url === '/models/use') return send(200, { ok: true, port: 8081 });
    if (req.url === '/desktop/status') return send(200, { state: 'none' });
    if (req.url === '/phone') return send(200, { ok: true, output: `Text sent to ${JSON.parse(raw).number}.` });
    if (req.url === '/ui/dump') return send(200, { app: 'com.example', screen: { width: 1080, height: 2400 }, nodes: [{ text: 'Send', kind: 'Button', x: 900, y: 2200, tap: true }] });
    if (req.url === '/ui/tap') return send(200, { ok: true, x: 900, y: 2200 });
    return send(409, { error: 'nope' });
  });
});
const base = `http://127.0.0.1:${PORT}`;
const procs = [];
const start = (args, env) => {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  procs.push(p);
  return p;
};
const cleanup = () => { fakeBridge.close(); for (const p of procs) p.kill(); fs.rmSync(home, { recursive: true, force: true }); };
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
  const env = { YAKK_HOME: path.join(home, wire), PORT: String(PORT), YAKK_PASSWORD: 'correct horse', NODE_NO_WARNINGS: '1', LLAMA_SERVER: path.join(root, 'tests/fake-llama-server.mjs'), YAKK_MODEL_PORT: '18881' };
  fs.mkdirSync(path.join(home, wire, 'models'), { recursive: true });
  fs.writeFileSync(path.join(home, wire, 'models', 'tiny.gguf'), 'GGUF');
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
  // Bot cards: share a bot, bring it back as a new one.
  await api('POST', `/bots/${second.id}/skills`, { name: 'Morning brief', body: 'Check the weather and my calendar.' });
  const cardRes = await fetch(`${base}/api/bots/${second.id}/card`, { headers: { cookie } });
  const botCard = await cardRes.json();
  check('a bot card carries the look, soul and skills', botCard.format === 'yakkbot-bot/1' && botCard.name === 'Scout' && botCard.soul.includes('Soul') && botCard.skills?.[0]?.name === 'Morning brief' && !('memory' in botCard), JSON.stringify(botCard).slice(0, 300));
  check('the card downloads as a file', /attachment; filename="Scout\.yakkbot\.json"/.test(cardRes.headers.get('content-disposition') ?? ''));
  const imported = (await api('POST', '/bots/import', { card: { ...botCard, name: 'Scout Two' } })).json.bot;
  check('importing a card makes a new bot', imported?.name === 'Scout Two' && imported.id !== second.id, JSON.stringify(imported));
  const importedSkills = (await api('GET', `/bots/${imported.id}/skills`)).json.skills;
  check('the imported bot has the skills', importedSkills?.[0]?.name === 'Morning brief');
  check('a file that is not a card is refused', (await api('POST', '/bots/import', { card: { hello: 1 } })).status === 400);
  await api('DELETE', `/bots/${imported.id}`);
  check('deleting a bot works', (await api('DELETE', `/bots/${second.id}`)).status === 200);

  // The Android app's phone bridge: pair, then use it through the device tool (with an approval).
  check('device tool is not offered before the app is paired', (await api('GET', '/device')).json.paired === false);
  check('pairing rejects a bad token', (await api('POST', '/device/pair', { port: BRIDGE, token: 'short' })).status === 400);
  const paired = (await api('POST', '/device/pair', { port: BRIDGE, token: BRIDGE_TOKEN, info: { device: 'Test Phone' } })).json;
  check('the app pairs and its bridge answers', paired.paired === true && paired.reachable === true, JSON.stringify(paired));
  await api('POST', `/bots/${bot.id}/messages`, { text: 'screen: read_screen' });
  rs = await settle(bot.id, (r) => r.some((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending'));
  const see = rs.find((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending');
  check('reading the screen asks first', !!see && /see what is on your screen/.test(see.body.title), JSON.stringify(rs.slice(-4).map((r) => r.body)));
  if (see) {
    await api('POST', `/approvals/${see.body.approvalId}`, { decision: 'always' });
    rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('Tool said: App in front'));
    check('the screen text reaches the bot', lastAssistant(rs) === 'Tool said: App in front: com.example. Screen 1080x2400.', lastAssistant(rs));
  }
  await api('POST', `/bots/${bot.id}/messages`, { text: 'screen: tap Send' });
  rs = await settle(bot.id, (r) => r.some((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending'));
  const tapCard = rs.find((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending');
  check('tapping asks separately', !!tapCard && /tap and type/.test(tapCard.body.title), JSON.stringify(tapCard?.body));
  if (tapCard) {
    await api('POST', `/approvals/${tapCard.body.approvalId}`, { decision: 'allow' });
    rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('Tool said: Tapped'));
    check('the tap reaches the phone bridge', bridgeCalls.some((c) => c.path === '/ui/tap' && c.body.text === 'Send'), JSON.stringify(bridgeCalls));
  }
  // Texting goes through the app (it has the SMS permission), after the owner approves it.
  await api('POST', `/bots/${bot.id}/messages`, { text: 'phone: sms_send {"number":"Mom","text":"on my way"}' });
  rs = await settle(bot.id, (r) => r.some((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending'));
  const smsCard = rs.find((x) => x.kind === 'card' && x.body.card === 'approval' && x.body.status === 'pending');
  check('texting asks first', !!smsCard && /text Mom/.test(smsCard.body.title), JSON.stringify(smsCard?.body));
  if (smsCard) {
    await api('POST', `/approvals/${smsCard.body.approvalId}`, { decision: 'allow' });
    rs = await settle(bot.id, (r) => lastAssistant(r)?.startsWith('Tool said: Text sent'));
    check('the text is sent through the app', bridgeCalls.some((c) => c.path === '/phone' && c.body.action === 'sms_send' && c.body.text === 'on my way'), JSON.stringify(bridgeCalls.slice(-2)));
  }
  check('the computer card can ask the app about the desktop', (await api('GET', '/desktop')).json.state === 'none');
  // Paired with the app (e.g. a Termux server opened inside it): its models run in the app's engine.
  bridgeCalls.length = 0;
  const viaAppModels = (await api('GET', '/phone-models')).json;
  check('with the app paired, models come from the app', viaAppModels.recommended === 'qwen35-2b' && bridgeCalls.some((c) => c.path === '/models/status'), JSON.stringify(viaAppModels).slice(0, 200));
  await api('DELETE', '/device');
  // Models on this device: a downloaded GGUF, run by llama-server (here a stand-in) when a bot uses it.
  const providers = (await api('GET', '/providers')).json.providers;
  const phoneProv = providers.find((p) => p.id === 'phone');
  check('on-device models are offered right after ready providers', providers.findIndex((p) => p.id === 'phone') <= providers.filter((p) => p.connected).length, providers.map((p) => p.id).join(','));
  check('the on-device provider lists downloaded models', phoneProv?.connected && phoneProv.models.includes('tiny.gguf'), JSON.stringify(phoneProv));
  const models = (await api('GET', '/phone-models')).json;
  check('the models page shows the engine, the list and the download', models.engine === true && models.catalog?.length > 5 && models.installed?.some((m) => m.file === 'tiny.gguf'), JSON.stringify(models).slice(0, 300));
  check('a download that is not from Hugging Face is refused', (await api('POST', '/phone-models/download', { url: 'https://example.com/x.gguf', file: 'x.gguf' })).status === 400);
  const third = (await api('POST', '/bots', { name: 'Pocket', mode: 'personal' })).json.bot;
  await api('PATCH', `/bots/${third.id}/engine`, { provider: 'phone', model: 'tiny.gguf' });
  await api('POST', `/bots/${third.id}/messages`, { text: 'offline hello' });
  rs = await settle(third.id, (r) => !!lastAssistant(r) || r.some((x) => x.kind === 'notice'));
  check('a bot answers with a model on this device', lastAssistant(rs) === 'You said: offline hello', lastAssistant(rs) ?? JSON.stringify(rs.slice(-1)));
  check('the engine is running that model', (await api('GET', '/phone-models')).json.running === 'tiny.gguf');
  await api('POST', '/phone-models/stop', {});
  await api('DELETE', `/bots/${third.id}`);
  await api('DELETE', `/bots/${third.id}`);
  await api('DELETE', '/device');

  // Conversations: a new chat keeps the old one, which can be reopened with its messages.
  const before = (await api('GET', `/bots/${bot.id}/conversations`)).json.conversations;
  const oldGen = before.find((c) => c.current).generation;
  await api('POST', `/bots/${bot.id}/fresh`, {});
  const after = (await api('GET', `/bots/${bot.id}/conversations`)).json.conversations;
  check('a new chat keeps the earlier conversation', after.some((c) => c.generation === oldGen && !c.current && c.messages > 0) && after.find((c) => c.current).generation > oldGen, JSON.stringify(after.slice(0, 3)));
  check('reopening an earlier conversation works', (await api('POST', `/bots/${bot.id}/conversations/${oldGen}/open`, {})).status === 200);
  const back = (await api('GET', `/bots/${bot.id}/rows`)).json;
  check('its messages come back', back.generation === oldGen && back.rows.some((r) => r.kind === 'message'), JSON.stringify(back).slice(0, 200));
  await api('POST', `/bots/${bot.id}/fresh`, {});
  const gens = (await api('GET', `/bots/${bot.id}/conversations`)).json.conversations.map((c) => c.generation);
  check('a new chat never reuses a conversation number', new Set(gens).size === gens.length, JSON.stringify(gens));

  // Social connections: bot friendships go both ways; people stay with the bot that knows them.
  const pal = (await api('POST', '/bots', { name: 'Pal' })).json.bot;
  await api('POST', `/bots/${bot.id}/connections`, { kind: 'bot', otherBotId: pal.id, relation: 'research buddy' });
  const mine = (await api('POST', `/bots/${bot.id}/connections`, { kind: 'person', name: 'Ana', relation: 'sister', note: 'loves hiking' })).json.connections;
  const theirs = (await api('GET', `/bots/${pal.id}/connections`)).json.connections;
  check('connecting two bots makes them friends both ways', mine.some((c) => c.kind === 'bot' && c.name === 'Pal') && theirs.some((c) => c.kind === 'bot' && c.otherBotId === bot.id), JSON.stringify({ mine, theirs }));
  check('a person is remembered with their relation', mine.some((c) => c.kind === 'person' && c.name === 'Ana' && c.relation === 'sister'));
  const friend = mine.find((c) => c.kind === 'bot');
  await api('DELETE', `/bots/${bot.id}/connections/${friend.id}`);
  check('unfriending removes both sides', !(await api('GET', `/bots/${pal.id}/connections`)).json.connections.length);
  await api('DELETE', `/bots/${pal.id}`);

  const setup = (await api('GET', '/computer/setup')).json;
  check('the computer page reports where bots work', ['none', 'local', 'orgo'].includes(setup.mode) && setup.maxBots > 0, JSON.stringify(setup));
  check('Orgo setup without a key asks for one', (await api('POST', '/computer/orgo/key', {})).status === 400);
  check('Orgo cannot be chosen before it is set up', (await api('POST', '/computer/mode', { mode: 'orgo' })).status === 400);
  check('switching to no computer works', (await api('POST', '/computer/mode', { mode: 'none' })).json.mode === 'none');
  await api('POST', '/computer/orgo/forget', {});
  const job = (await api('GET', '/setup/engine')).json;
  check('the engine setup job reports its state', job.state === 'idle' && typeof job.available === 'boolean', JSON.stringify(job));
  check('an unknown setup job is refused', (await api('POST', '/setup/rm-rf', {})).status === 404);

  const mcp = await fetch(`${base}/mcp/${bot.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('MCP endpoint refuses a caller without the token', mcp.status === 401);

  server.kill();
  await sleep(400);
}

try {
  await new Promise((r) => fakeBridge.listen(BRIDGE, '127.0.0.1', r));
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
