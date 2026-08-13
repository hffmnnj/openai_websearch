/**
 * openai_websearch — Reusable API client for OpenAI's native web search.
 *
 * Zero runtime dependencies (works in Node.js 18+, Bun, Deno).
 *
 * @example
 *   import { search, imageSearch, createClient } from 'openai_websearch';
 *
 *   // Simple
 *   const results = await search('latest smart ring news');
 *   console.log(results.text);
 *
 *   // With options
 *   const deep = await search('competitor analysis', { contextSize: 'high', model: 'gpt-5.6-luna' });
 *
 *   // Image search
 *   const images = await imageSearch('oura ring product photos');
 *
 *   // Advanced: custom client with explicit auth
 *   const client = createClient({ authPath: '/custom/path/auth.json', model: 'gpt-5.6-luna' });
 *   const r = await client.search('test query');
 */

import { AuthManager, jwtExpiry } from './auth.js';

export * from './auth.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MODEL = 'gpt-5.6-luna';
// Upstream timeout: abort the fetch to OpenAI after this many ms.
// Must be shorter than MCP client timeouts (Hermes 60s, OpenCode default ~30-60s).
const UPSTREAM_TIMEOUT_MS = 50_000;

// ─── SSE Parser ───────────────────────────────────────────────────────────────

async function* parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const dataStart = buffer.indexOf('data: ');
        if (dataStart === -1) break;

        const dataEnd = buffer.indexOf('\n', dataStart);
        if (dataEnd === -1) break;

        const dataStr = buffer.slice(dataStart + 6, dataEnd);
        buffer = buffer.slice(dataEnd + 1);

        if (!dataStr || dataStr === '[DONE]') continue;

        try {
          yield JSON.parse(dataStr);
        } catch {
          buffer = dataStr + buffer;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Core API ─────────────────────────────────────────────────────────────────

async function _callAPI(authManager, { input, tools, model }) {
  const { token, accountId } = await authManager.getValidToken();

  // Abort upstream fetch after UPSTREAM_TIMEOUT_MS to prevent indefinite hangs.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'ChatGPT-Account-Id': accountId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [{ type: 'message', role: 'user', content: input }],
        tools,
        store: false,
        stream: true,
        // Performance knobs: priority tier + low reasoning for fast search responses.
        // Without these, OpenAI processes at default priority with full reasoning,
        // causing 25-45s+ response times that exceed MCP client timeouts.
        service_tier: 'priority',
        reasoning: { effort: 'low' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`OpenAI upstream timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  clearTimeout(timeoutId);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API error (${resp.status}): ${text}`);
  }

  return parseSSEStream(resp.body);
}

async function _processStream(stream) {
  const searchQueries = [];
  const messageChunks = [];
  let usage = null;

  for await (const event of stream) {
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

// ─── Client Class ─────────────────────────────────────────────────────────────

/**
 * OpenAI Web Search client.
 *
 * @example
 *   const client = new OpenAIWebSearch({ model: 'gpt-5.6-luna' });
 *   const result = await client.search('smart ring market size 2026');
 *   console.log(result.text);
 */
export class OpenAIWebSearch {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.authPath] - Path to auth.json (default: ~/.openai-websearch/auth.json, falls back to ~/.codex/auth.json)
   * @param {string} [opts.accessToken] - Explicit access token (skip file loading)
   * @param {string} [opts.refreshToken] - Explicit refresh token
   * @param {string} [opts.accountId] - Explicit account ID
   * @param {string} [opts.model] - Default model (default: gpt-5.6-luna)
   * @param {boolean} [opts.fallbackToCodex] - Fall back to ~/.codex/auth.json (default: true)
   */
  constructor(opts = {}) {
    this.auth = new AuthManager(opts);
    this.model = opts.model || process.env.OPENAI_WEBSEARCH_MODEL || DEFAULT_MODEL;
  }

  /**
   * Search the web.
   *
   * @param {string} query - What to search for
   * @param {Object} [opts]
   * @param {'low'|'medium'|'high'} [opts.contextSize='medium']
   * @param {string} [opts.model] - Override the default model
   * @returns {Promise<SearchResult>}
   */
  async search(query, opts = {}) {
    const model = opts.model || this.model;
    const contextSize = opts.contextSize || 'medium';

    const stream = await _callAPI(this.auth, {
      input: query,
      tools: [{ type: 'web_search', search_context_size: contextSize }],
      model,
    });

    const result = await _processStream(stream);
    result.model = model;
    return result;
  }

  /**
   * Search the web for images. Returns image URLs and source pages.
   *
   * @param {string} query - What images to search for
   * @param {Object} [opts]
   * @param {'low'|'medium'|'high'} [opts.contextSize='medium']
   * @param {string} [opts.model] - Override the default model
   * @returns {Promise<SearchResult>}
   */
  async imageSearch(query, opts = {}) {
    const model = opts.model || this.model;
    const contextSize = opts.contextSize || 'medium';

    const stream = await _callAPI(this.auth, {
      input: `Search for images of: ${query}. List the top image URLs you find with their source pages. Format each as: IMAGE_URL | SOURCE_PAGE | DESCRIPTION`,
      tools: [{ type: 'web_search', search_context_size: contextSize }],
      model,
    });

    const result = await _processStream(stream);
    result.model = model;
    return result;
  }
}

// ─── Convenience Functions ────────────────────────────────────────────────────

/** Shared default client (lazy-initialized) */
let _defaultClient = null;

function _getDefaultClient() {
  if (!_defaultClient) {
    _defaultClient = new OpenAIWebSearch();
  }
  return _defaultClient;
}

/**
 * Search the web using the default client.
 *
 * @param {string} query
 * @param {Object} [opts] - { contextSize, model }
 * @returns {Promise<{text: string, searchQueries: string[], usage: object, model: string}>}
 *
 * @example
 *   import { search } from 'openai_websearch';
 *   const result = await search('smart ring news', { contextSize: 'high' });
 *   console.log(result.text);
 */
export async function search(query, opts) {
  return _getDefaultClient().search(query, opts);
}

/**
 * Search the web for images using the default client.
 *
 * @param {string} query
 * @param {Object} [opts] - { contextSize, model }
 * @returns {Promise<{text: string, searchQueries: string[], usage: object, model: string}>}
 *
 * @example
 *   import { imageSearch } from 'openai_websearch';
 *   const result = await imageSearch('oura ring product photos');
 *   console.log(result.text);
 */
export async function imageSearch(query, opts) {
  return _getDefaultClient().imageSearch(query, opts);
}

/**
 * Create a new client with custom options.
 *
 * @param {Object} opts - See OpenAIWebSearch constructor
 * @returns {OpenAIWebSearch}
 *
 * @example
 *   import { createClient } from 'openai_websearch';
 *   const client = createClient({ model: 'gpt-5.6-luna' });
 *   const result = await client.search('test');
 */
export function createClient(opts) {
  return new OpenAIWebSearch(opts);
}

export default OpenAIWebSearch;
