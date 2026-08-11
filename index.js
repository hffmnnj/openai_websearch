#!/usr/bin/env node

/**
 * openai_websearch — MCP server that exposes OpenAI's native server-side web search.
 *
 * Uses your existing Codex CLI auth (ChatGPT subscription) for authentication.
 * Auto-refreshes OAuth tokens from ~/.codex/auth.json.
 *
 * Tools exposed:
 *   - web_search       — Text web search with configurable context size
 *   - image_search     — Image web search, returns image URLs
 *
 * No external dependencies. Pure Node.js stdlib + MCP over stdio.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

// ─── Config ───────────────────────────────────────────────────────────────────

const CODEX_AUTH_PATH = process.env.CODEX_AUTH_PATH ||
  join(homedir(), '.codex', 'auth.json');

const OPENAI_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_MODEL = process.env.OPENAI_WEBSEARCH_MODEL || 'gpt-5.6-luna';

// 5 minute buffer before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Auth ─────────────────────────────────────────────────────────────────────

let cachedToken = null;
let cachedTokenExpiry = 0;
let cachedAccountId = null;

function loadAuthFromCodex() {
  if (!existsSync(CODEX_AUTH_PATH)) {
    throw new Error(`Codex auth file not found at ${CODEX_AUTH_PATH}. Run 'codex' and log in first.`);
  }
  const raw = readFileSync(CODEX_AUTH_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const tokens = data.tokens || data;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: data.account_id || tokens.account_id,
  };
}

async function refreshOAuthToken(refreshToken) {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const resp = await fetch(OPENAI_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 864000,
  };
}

function jwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return (decoded.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

async function getValidToken() {
  const now = Date.now();

  // Check cache first
  if (cachedToken && now < cachedTokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
    return { token: cachedToken, accountId: cachedAccountId };
  }

  // Load from codex auth
  const auth = loadAuthFromCodex();

  // Check if current token from file is still valid
  const fileExpiry = jwtExpiry(auth.accessToken);
  if (fileExpiry > now + TOKEN_REFRESH_BUFFER_MS) {
    cachedToken = auth.accessToken;
    cachedTokenExpiry = fileExpiry;
    cachedAccountId = auth.accountId;
    return { token: cachedToken, accountId: cachedAccountId };
  }

  // Refresh
  const refreshed = await refreshOAuthToken(auth.refreshToken);

  // Update the codex auth file with new tokens
  try {
    const raw = readFileSync(CODEX_AUTH_PATH, 'utf-8');
    const data = JSON.parse(raw);
    data.tokens.access_token = refreshed.accessToken;
    data.tokens.refresh_token = refreshed.refreshToken;
    data.last_refresh = new Date().toISOString();
    writeFileSync(CODEX_AUTH_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    // Non-fatal — we still have the in-memory token
    process.stderr.write(`[openai_websearch] Warning: could not update auth file: ${e.message}\n`);
  }

  cachedToken = refreshed.accessToken;
  cachedTokenExpiry = now + refreshed.expiresIn * 1000;
  cachedAccountId = auth.accountId;
  return { token: cachedToken, accountId: cachedAccountId };
}

// ─── OpenAI API ───────────────────────────────────────────────────────────────

async function callOpenAIResponses({ input, tools, model = DEFAULT_MODEL }) {
  const { token, accountId } = await getValidToken();

  const body = {
    model,
    input: [
      {
        type: 'message',
        role: 'user',
        content: input,
      },
    ],
    tools,
    store: false,
    stream: true,
  };

  const resp = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'ChatGPT-Account-Id': accountId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API error (${resp.status}): ${text}`);
  }

  return parseSSEStream(resp.body);
}

/**
 * Parse SSE stream from OpenAI Responses API.
 * Extracts web_search_call actions, message text, and image results.
 */
async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      while (true) {
        const dataStart = buffer.indexOf('data: ');
        if (dataStart === -1) break;

        const dataEnd = buffer.indexOf('\n', dataStart);
        if (dataEnd === -1) break;

        const dataStr = buffer.slice(dataStart + 6, dataEnd);
        buffer = buffer.slice(dataEnd + 1);

        if (!dataStr || dataStr === '[DONE]') continue;

        try {
          const event = JSON.parse(dataStr);
          yield event;
        } catch {
          // Incomplete JSON, put it back
          buffer = dataStr + buffer;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function processSearchStream(stream, { wantImages = false } = {}) {
  const searchQueries = [];
  const messageChunks = [];
  let usage = null;

  for await (const event of stream) {
    // Capture search queries
    if (event.type === 'response.output_item.done' && event.item?.type === 'web_search_call') {
      if (event.item.action?.queries) {
        searchQueries.push(...event.item.action.queries);
      }
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
      for (const content of (event.item.content || [])) {
        if (content.type === 'output_text' && content.text) {
          messageChunks.push(content.text);
        }
      }
    }

    // Capture usage
    if (event.type === 'response.completed') {
      usage = event.response?.usage || null;
    }
  }

  return {
    text: messageChunks.join(''),
    searchQueries,
    usage,
  };
}

// ─── MCP Protocol ─────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2024-11-05';

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

// ─── Tool Execution ───────────────────────────────────────────────────────────

async function executeWebSearch(args) {
  const { query, context_size = 'medium', model } = args;

  const tools = [{
    type: 'web_search',
    search_context_size: context_size,
  }];

  const eventStream = await callOpenAIResponses({
    input: query,
    tools,
    model,
  });

  const result = await processSearchStream(eventStream, { wantImages: false });

  // Build clean output
  const parts = [];

  if (result.searchQueries.length > 0) {
    parts.push(`**Searched for:** ${result.searchQueries.map(q => `"${q}"`).join(', ')}\n`);
  }

  if (result.text) {
    parts.push(result.text);
  }

  if (result.usage) {
    const u = result.usage;
    parts.push(`\n---\n*Tokens: ${u.input_tokens || 0} in, ${u.output_tokens || 0} out (${(u.total_tokens || 0)} total)*`);
  }

  return parts.join('\n');
}

async function executeImageSearch(args) {
  const { query, context_size = 'medium', model } = args;

  // Ask the model to search for images and return URLs
  const tools = [{
    type: 'web_search',
    search_context_size: context_size,
  }];

  const eventStream = await callOpenAIResponses({
    input: `Search for images of: ${query}. List the top image URLs you find with their source pages. Format each as: IMAGE_URL | SOURCE_PAGE | DESCRIPTION`,
    tools,
    model,
  });

  const result = await processSearchStream(eventStream, { wantImages: true });

  const parts = [];

  if (result.searchQueries.length > 0) {
    parts.push(`**Searched for:** ${result.searchQueries.map(q => `"${q}"`).join(', ')}\n`);
  }

  if (result.text) {
    parts.push(result.text);
  }

  if (result.usage) {
    const u = result.usage;
    parts.push(`\n---\n*Tokens: ${u.input_tokens || 0} in, ${u.output_tokens || 0} out*`);
  }

  return parts.join('\n');
}

// ─── MCP Server (stdio) ───────────────────────────────────────────────────────

let msgId = 0;

function makeResponse(id, result) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function makeError(id, code, message) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      return makeResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: 'openai_websearch',
          version: '1.0.0',
        },
      });
    }

    case 'notifications/initialized': {
      return null; // notification, no response
    }

    case 'tools/list': {
      return makeResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      const parsed = typeof args === 'string' ? JSON.parse(args) : (args || {});

      try {
        let output;
        switch (name) {
          case 'web_search':
            output = await executeWebSearch(parsed);
            break;
          case 'image_search':
            output = await executeImageSearch(parsed);
            break;
          default:
            return makeError(id, -32601, `Unknown tool: ${name}`);
        }

        return makeResponse(id, {
          content: [{ type: 'text', text: output }],
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
    await getValidToken();
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
