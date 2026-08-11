#!/usr/bin/env node

/**
 * openai_websearch — MCP server entry point.
 *
 * Supports three transports:
 *   stdio (default)   — node index.js
 *   http              — node index.js --transport http [--port 3103] [--host 0.0.0.0]
 *
 * CLI commands:
 *   node index.js login               — browser OAuth flow
 *   node index.js login --device-code — headless device-code flow
 *   node index.js auth-status         — show auth status
 */

import { Command } from 'commander';
import { createMcpServer } from './mcp.js';
import { OpenAIWebSearch } from './lib/index.js';
import {
  authenticateBrowser,
  authenticateDeviceCode,
  loadAuthFile,
  defaultAuthPath,
  inferAccountId,
  saveAuthFile,
} from './lib/auth.js';

// ─── CLI login command ────────────────────────────────────────────────────────

async function cmdLogin(args) {
  try {
    let result;
    if (args.includes('--device-code')) {
      result = await authenticateDeviceCode();
    } else {
      result = await authenticateBrowser();
    }

    const accountId = inferAccountId(result.tokens.access_token);
    const path = saveAuthFile(result.tokens, {
      idToken: result.tokens.id_token,
      accountId,
    });

    console.error('[openai_websearch] Auth saved to ' + path);
    console.error('[openai_websearch] You are authenticated. Start the MCP server normally to search.');
    process.exit(0);
  } catch (e) {
    console.error('[openai_websearch] Login failed: ' + e.message);
    process.exit(1);
  }
}

async function cmdAuthStatus() {
  const path = defaultAuthPath();
  const data = loadAuthFile(path);
  if (!data?.tokens?.access_token) {
    console.error('[openai_websearch] Not authenticated. Run: node index.js login');
    process.exit(1);
  }
  const payload = data.tokens.access_token.split('.')[1];
  let exp = 'unknown';
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    exp = new Date((decoded.exp || 0) * 1000).toISOString();
  } catch {}
  console.error('[openai_websearch] Auth file: ' + path);
  console.error('[openai_websearch] Last refresh: ' + (data.last_refresh || 'unknown'));
  console.error('[openai_websearch] Access token expires: ' + exp);
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Commands
  if (args.includes('login')) return cmdLogin(args);
  if (args.includes('auth-status')) return cmdAuthStatus();

  // Transport selection
  const program = new Command();
  program
    .option('--transport <stdio|http>', 'Transport type', process.env.OPENAI_WEBSEARCH_TRANSPORT || 'stdio')
    .option('--port <number>', 'HTTP port', process.env.OPENAI_WEBSEARCH_PORT || '3103')
    .option('--host <string>', 'HTTP host', process.env.OPENAI_WEBSEARCH_HOST || '0.0.0.0')
    .option('--token <string>', 'Bearer token for HTTP auth', process.env.OPENAI_WEBSEARCH_TOKEN || '')
    .allowUnknownOption()
    .parse(process.argv);

  const opts = program.opts();

  if (opts.transport === 'http') {
    const { startServer } = await import('./http.js');
    startServer(parseInt(opts.port), opts.host, { token: opts.token || undefined });
  } else {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    console.error('[openai_websearch] MCP server running on stdio (official MCP SDK)');
  }
}

main().catch(e => {
  console.error('[openai_websearch] Fatal: ' + e.message);
  process.exit(1);
});
