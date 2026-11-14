#!/usr/bin/env node
// Stands in for llama.cpp's llama-server in tests: serves the mock model on the --port it is given.
const i = process.argv.indexOf('--port');
process.argv[2] = i > 0 ? process.argv[i + 1] : '8081';
process.argv.length = 3;
await import('./mock-llm.mjs');
