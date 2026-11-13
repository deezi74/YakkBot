// A stand-in model server for tests: speaks both the OpenAI chat-completions protocol and the
// Anthropic Messages protocol, streaming. What it "decides" depends only on the last message:
//   "run: <cmd>"       -> calls the terminal tool
//   "remember: <text>" -> calls the memory tool
//   "ask: <question>"  -> calls ask_user
//   after a tool result -> answers "Tool said: <first line>"
//   anything else      -> answers "You said: <text>"
import http from 'node:http';

const port = Number(process.argv[2] ?? 8799);
export const seen = [];

function decide(lastUserText, lastToolOutput) {
  if (lastToolOutput !== null) return { text: `Tool said: ${String(lastToolOutput).split('\n')[0].slice(0, 200)}` };
  const t = lastUserText.replace(/^\[[^\]]*\]\n/, '');
  let m;
  if ((m = /^run:\s*([\s\S]+)/.exec(t))) return { think: 'I should run that.', call: { name: 'terminal', args: { command: m[1].trim() } } };
  if ((m = /^remember:\s*([\s\S]+)/.exec(t))) return { call: { name: 'memory', args: { action: 'add', target: 'user', text: m[1].trim() } } };
  if ((m = /^ask:\s*([\s\S]+)/.exec(t))) return { call: { name: 'ask_user', args: { question: m[1].trim(), options: ['Yes', 'No'] } } };
  return { text: `You said: ${t}` };
}

const sse = (res, obj, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`);

function openai(body, res) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  const d = decide(last.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.find((c) => c.type === 'text')?.text ?? '') : '', last.role === 'tool' ? last.content : null);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (d.think) sse(res, { choices: [{ delta: { reasoning_content: `**Planning** ${d.think}` } }] });
  if (d.text) for (const piece of d.text.match(/.{1,12}/gs)) sse(res, { choices: [{ delta: { content: piece } }] });
  if (d.call) {
    sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: d.call.name, arguments: '' } }] } }] });
    const a = JSON.stringify(d.call.args);
    sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, 5) } }] } }] });
    sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(5) } }] } }] });
  }
  sse(res, { choices: [{ delta: {}, finish_reason: d.call ? 'tool_calls' : 'stop' }] });
  res.end('data: [DONE]\n\n');
}

function anthropic(body, res) {
  const last = body.messages[body.messages.length - 1];
  const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
  const tr = blocks.find((b) => b.type === 'tool_result');
  const trText = tr ? (Array.isArray(tr.content) ? tr.content.map((c) => c.text ?? '').join('') : String(tr.content)) : null;
  const d = decide(blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), trText);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const msg = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  sse(res, { type: 'message_start', message: msg }, 'message_start');
  let i = 0;
  if (d.think) {
    sse(res, { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } }, 'content_block_start');
    sse(res, { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: `**Planning** ${d.think}` } }, 'content_block_delta');
    sse(res, { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig' } }, 'content_block_delta');
    sse(res, { type: 'content_block_stop', index: i++ }, 'content_block_stop');
  }
  if (d.text) {
    sse(res, { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, 'content_block_start');
    for (const piece of d.text.match(/.{1,12}/gs)) sse(res, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } }, 'content_block_delta');
    sse(res, { type: 'content_block_stop', index: i++ }, 'content_block_stop');
  }
  if (d.call) {
    sse(res, { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: d.call.name, input: {} } }, 'content_block_start');
    sse(res, { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(d.call.args) } }, 'content_block_delta');
    sse(res, { type: 'content_block_stop', index: i++ }, 'content_block_stop');
  }
  sse(res, { type: 'message_delta', delta: { stop_reason: d.call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }, 'message_delta');
  sse(res, { type: 'message_stop' }, 'message_stop');
  res.end();
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* not json */ }
    seen.push({ url: req.url, body });
    if (process.env.MOCK_LOG) console.log('[mock]', req.url, JSON.stringify(body).slice(0, 600));
    if (req.url.includes('/chat/completions')) return openai(body, res);
    if (req.url.includes('/v1/messages')) return anthropic(body, res);
    res.writeHead(404).end('{}');
  });
});
server.listen(port, '127.0.0.1', () => console.log(`[mock-llm] on ${port}`));
