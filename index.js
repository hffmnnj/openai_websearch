#!/usr/bin/env node

/**
 * openai_websearch — MCP server entry point.
 *
 * The reusable API client lives in ./lib/index.js.
 * This file wraps it as an MCP-over-stdio server.
 *
 * Tools exposed:
 *   - web_search       — Text web search with configurable context size
 *   - image_search     — Image web search, returns image URLs
 */

import { createInterface } from 'readline';
import { OpenAIWebSearch } from './lib/index.js';

const PROTOCOL_VERSION = '2024-11-05';

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web using OpenAI\'s native server-side web search. Returns clean, up-to-date results with real URLs and citations. Powered by your ChatGPT/Codex subscription.\n\nBest for:\n- Finding current information, news, or facts\n- Research with real citations and URLs\n- Getting summarized answers with sources\n\nUsage notes:\n- search_context_size controls how much web content is retrieved: "low" (fast), "medium" (balanced, default), "high" (thorough)\n- Results include the queries OpenAI actually searched for\n- All search happens server-side at OpenAI, not locally',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for. Be specific for best results.',
        },
        context_size: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'How much web context to retrieve. "low" = fast/cheap, "medium" = balanced (default), "high" = thorough/deep.',
        },
        model: {
          type: 'string',
          description: 'OpenAI model to use (default: gpt-5.6-luna). Must be available in your Codex subscription.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'image_search',
    description: 'Search the web for images using OpenAI\'s native web search with image results. Returns image URLs, titles, and source pages.\n\nBest for:\n- Finding relevant images from across the web\n- Getting image URLs you can use or reference\n- Visual research with real source URLs\n\nUsage notes:\n- Returns image URLs from web pages, not AI-generated images\n- context_size controls search depth\n- Results include source page URLs',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What images to search for.',
        },
        context_size: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Search depth: "low" (fast), "medium" (default), "high" (thorough).',
        },
        model: {
          type: 'string',
          description: 'OpenAI model to use (default: gpt-5.6-luna).',
        },
      },
      required: ['query'],
    },
  },
];

// ─── MCP Server ───────────────────────────────────────────────────────────────

const client = new OpenAIWebSearch();

function makeResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function makeError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'openai_websearch', version: '1.1.0' },
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return makeResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const { name, arguments: args } = params;
      const parsed = typeof args === 'string' ? JSON.parse(args) : (args || {});

      try {
        let result;
        switch (name) {
          case 'web_search':
            result = await client.search(parsed.query, {
              contextSize: parsed.context_size,
              model: parsed.model,
            });
            break;
          case 'image_search':
            result = await client.imageSearch(parsed.query, {
              contextSize: parsed.context_size,
              model: parsed.model,
            });
            break;
          default:
            return makeError(id, -32601, `Unknown tool: ${name}`);
        }

        // Format output
        const parts = [];
        if (result.searchQueries.length > 0) {
          parts.push(`**Searched for:** ${result.searchQueries.map(q => `"${q}"`).join(', ')}\n`);
        }
        if (result.text) {
          parts.push(result.text);
        }
        if (result.usage) {
          const u = result.usage;
          parts.push(`\n---\n*Tokens: ${u.input_tokens || 0} in, ${u.output_tokens || 0} out (${u.total_tokens || 0} total)*`);
        }

        return makeResponse(id, {
          content: [{ type: 'text', text: parts.join('\n') }],
        });
      } catch (e) {
        return makeResponse(id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        });
      }
    }

    default:
      return makeError(id, -32601, `Unknown method: ${method}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Verify auth is available
  try {
    await client.auth.getValidToken();
    process.stderr.write('[openai_websearch] Ready — auth loaded from ~/.codex/auth.json\n');
  } catch (e) {
    process.stderr.write(`[openai_websearch] Auth error: ${e.message}\n`);
    process.stderr.write('[openai_websearch] Run "codex" and log in with your ChatGPT account first.\n');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin });
  process.stderr.write('[openai_websearch] MCP server listening on stdio\n');

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);

      if (response !== null) {
        process.stdout.write(response + '\n');
      }
    } catch (e) {
      process.stderr.write(`[openai_websearch] Error handling message: ${e.message}\n`);
    }
  }
}

main().catch(e => {
  process.stderr.write(`[openai_websearch] Fatal: ${e.message}\n`);
  process.exit(1);
});
