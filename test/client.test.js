/**
 * Quick smoke test for the openai_websearch library API.
 * Run: node test/client.test.js
 */

import { search, imageSearch, createClient, OpenAIWebSearch } from '../lib/index.js';

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('openai_websearch library tests\n');

// Test 1: search() returns structured result
console.log('Test 1: search() returns structured result');
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

// Test 4: MCP server still works
console.log('\nTest 4: MCP server tools/list');
try {
  const { execSync } = await import('child_process');
  const output = execSync(
    `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | timeout 5 node ${new URL('../index.js', import.meta.url).pathname}`,
    { encoding: 'utf-8', timeout: 10000 }
  );
  const data = JSON.parse(output.trim());
  const toolNames = data.result?.tools?.map(t => t.name) || [];
  assert('returns tools list', toolNames.length === 2);
  assert('has web_search', toolNames.includes('web_search'));
  assert('has image_search', toolNames.includes('image_search'));
} catch (e) {
  console.log(`    ERROR: ${e.message}`);
  failed++;
}

// Summary
console.log(`\n${'='.repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
