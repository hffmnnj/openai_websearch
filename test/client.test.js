/**
 * Smoke tests for the openai_websearch library + MCP server.
 * Run: npm test
 */

import { search, imageSearch, createClient, OpenAIWebSearch } from '../lib/index.js';
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  jwtExpiry,
  inferAccountId,
  AuthManager,
  CLIENT_ID,
  CALLBACK_PORT,
} from '../lib/auth.js';

let passed = 0;
let failed = 0;

function assert(name, condition, extra = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} ${extra}`);
    failed++;
  }
}

console.log('openai_websearch tests\n');

// Test 0: Auth helpers
console.log('Test 0: auth helpers');
{
  const { verifier, challenge } = generatePkce();
  assert('PKCE verifier generated', typeof verifier === 'string' && verifier.length > 30);
  assert('PKCE challenge generated', typeof challenge === 'string' && challenge.length > 30);
  assert('challenge != verifier', challenge !== verifier);

  const state = generateState();
  assert('state generated', typeof state === 'string' && state.length > 10);

  const url = buildAuthorizeUrl({ state, challenge });
  assert('authorize URL built', url.startsWith('https://auth.openai.com/oauth/authorize?'));
  assert('authorize URL has client_id', url.includes(`client_id=${CLIENT_ID}`));
  assert('authorize URL has code_challenge', url.includes('code_challenge='));
  assert('authorize URL has codex flags', url.includes('codex_cli_simplified_flow=true') && url.includes('originator=codex_cli_rs'));
  assert('authorize URL has localhost:1455 redirect', decodeURIComponent(url).includes(`localhost:${CALLBACK_PORT}`));

  assert('jwtExpiry returns 0 on garbage', jwtExpiry('not-a-jwt') === 0);
  assert('inferAccountId returns null on garbage', inferAccountId('not-a-jwt') === null);
}

// Test 1: search() returns structured result
console.log('\nTest 1: search() returns structured result');
try {
  const result = await search('What is 2+2?', { contextSize: 'low' });
  assert('returns object', typeof result === 'object');
  assert('has text', typeof result.text === 'string' && result.text.length > 0);
  assert('has searchQueries', Array.isArray(result.searchQueries));
  assert('has usage', typeof result.usage === 'object');
  assert('has model', typeof result.model === 'string');
  console.log(`    model: ${result.model}`);
  console.log(`    text preview: ${result.text.slice(0, 100)}...`);
} catch (e) {
  console.log(`    ERROR: ${e.message}`);
  failed++;
}

// Test 2: imageSearch() returns image results
console.log('\nTest 2: imageSearch() returns image results');
try {
  const result = await imageSearch('cute cat', { contextSize: 'low' });
  assert('returns object', typeof result === 'object');
  assert('has text', typeof result.text === 'string' && result.text.length > 0);
  console.log(`    text preview: ${result.text.slice(0, 100)}...`);
} catch (e) {
  console.log(`    ERROR: ${e.message}`);
  failed++;
}

// Test 3: createClient() with custom model
console.log('\nTest 3: createClient() with custom model');
try {
  const client = createClient({ model: 'gpt-5.4' });
  assert('returns OpenAIWebSearch instance', client instanceof OpenAIWebSearch);
  assert('model is gpt-5.4', client.model === 'gpt-5.4');
} catch (e) {
  console.log(`    ERROR: ${e.message}`);
  failed++;
}

// Test 4: MCP server (official SDK) tools/list
console.log('\nTest 4: MCP server tools/list (official SDK)');
try {
  const { execSync } = await import('child_process');
  const output = execSync(
    `(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'; sleep 0.3; echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}') | timeout 8 node ${new URL('../index.js', import.meta.url).pathname}`,
    { encoding: 'utf-8', timeout: 15000 }
  );
  const lines = output.trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  const toolNames = last.result?.tools?.map(t => t.name) || [];
  assert('returns tools list', toolNames.length === 2);
  assert('has web_search', toolNames.includes('web_search'));
  assert('has image_search', toolNames.includes('image_search'));
  assert('has JSON Schema inputSchema', typeof last.result.tools[0].inputSchema?.properties?.query === 'object');
} catch (e) {
  console.log(`    ERROR: ${e.message}`);
  failed++;
}

// Summary
console.log(`\n${'='.repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
