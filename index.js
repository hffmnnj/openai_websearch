#!/usr/bin/env node

/**
 * openai_websearch — MCP server (official @modelcontextprotocol/sdk).
 *
 * Exposes OpenAI's native server-side web search as MCP tools:
 *   - web_search       — Text web search with configurable context size
 *   - image_search     — Image search, returns image URLs
 *
 * Auth: browser OAuth (URL), device-code flow, or existing Codex auth.
 * Run `node index.js login` or `node index.js login --device-code` to authenticate.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
  const expiry = data.tokens.access_token.split('.')[1];
  let exp = 'unknown';
  try {
    const decoded = JSON.parse(Buffer.from(expiry, 'base64url').toString());
    exp = new Date((decoded.exp || 0) * 1000).toISOString();
  } catch {}
  console.error('[openai_websearch] Auth file: ' + path);
  console.error('[openai_websearch] Last refresh: ' + (data.last_refresh || 'unknown'));
  console.error('[openai_websearch] Access token expires: ' + exp);
  process.exit(0);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({
    name: 'openai_websearch',
    version: '1.2.0',
  });

  const client = new OpenAIWebSearch();

  server.registerTool(
    'web_search',
    {
      title: 'Web Search',
      description: `Search the web using OpenAI's native server-side web search. Returns clean, up-to-date results with real URLs and citations. Powered by your ChatGPT/Codex subscription.
- contextSize: "low" (fast/cheap), "medium" (balanced, default), "high" (thorough/deep)
- All search happens server-side at OpenAI, not locally
- Results include the queries OpenAI actually searched for`,
      inputSchema: z.object({
        query: z.string().min(1).describe('What to search for. Be specific for best results.'),
        context_size: z.enum(['low', 'medium', 'high']).optional().default('medium')
          .describe('How much web context to retrieve'),
        model: z.string().optional().describe('OpenAI model to use (default: gpt-5.6-luna)'),
      }),
    },
    async ({ query, context_size, model }) => {
      const result = await client.search(query, {
        contextSize: context_size,
        model,
      });

      const parts = [];
      if (result.searchQueries.length > 0) {
        parts.push(`**Searched for:** ${result.searchQueries.map(q => `"${q}"`).join(', ')}\n`);
      }
      if (result.text) parts.push(result.text);
      if (result.usage) {
        const u = result.usage;
        parts.push(`\n---\n*Tokens: ${u.input_tokens || 0} in, ${u.output_tokens || 0} out (${u.total_tokens || 0} total)*`);
      }
      return { content: [{ type: 'text', text: parts.join('\n') }] };
    },
  );

  server.registerTool(
    'image_search',
    {
      title: 'Image Search',
      description: `Search the web for images using OpenAI's native web search. Returns image URLs, titles, and source pages.
- Returns real image URLs from web pages, not AI-generated images
- contextSize controls search depth`,
      inputSchema: z.object({
        query: z.string().min(1).describe('What images to search for.'),
        context_size: z.enum(['low', 'medium', 'high']).optional().default('medium')
          .describe('Search depth'),
        model: z.string().optional().describe('OpenAI model to use (default: gpt-5.6-luna)'),
      }),
    },
    async ({ query, context_size, model }) => {
      const result = await client.imageSearch(query, {
        contextSize: context_size,
        model,
      });

      const parts = [];
      if (result.searchQueries.length > 0) {
        parts.push(`**Searched for:** ${result.searchQueries.map(q => `"${q}"`).join(', ')}\n`);
      }
      if (result.text) parts.push(result.text);
      if (result.usage) {
        const u = result.usage;
        parts.push(`\n---\n*Tokens: ${u.input_tokens || 0} in, ${u.output_tokens || 0} out*`);
      }
      return { content: [{ type: 'text', text: parts.join('\n') }] };
    },
  );

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('login')) return cmdLogin(args);
  if (args.includes('auth-status')) return cmdAuthStatus();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[openai_websearch] MCP server running on stdio (official MCP SDK)');
}

main().catch(e => {
  console.error('[openai_websearch] Fatal: ' + e.message);
  process.exit(1);
});
