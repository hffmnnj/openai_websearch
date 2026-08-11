/**
 * openai_websearch — Reusable API client for OpenAI's native web search.
 *
 * Zero dependencies. Works in Node.js 18+, Bun, Deno, and any JS runtime
 * with native fetch and ESM import support.
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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const AUTH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Auth Manager ─────────────────────────────────────────────────────────────

class AuthManager {
  constructor({ authPath, accessToken, refreshToken, accountId } = {}) {
    this.authPath = authPath || process.env.CODEX_AUTH_PATH || DEFAULT_AUTH_PATH;
    this._explicitToken = accessToken || null;
    this._explicitRefresh = refreshToken || null;
    this._explicitAccount = accountId || null;
    this._cachedToken = null;
    this._cachedExpiry = 0;
    this._cachedAccount = null;
  }

  _loadFromFile() {
    if (!existsSync(this.authPath)) {
      throw new Error(`Codex auth file not found at ${this.authPath}. Run 'codex' and log in first.`);
    }
    const raw = readFileSync(this.authPath, 'utf-8');
    const data = JSON.parse(raw);
    const tokens = data.tokens || data;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId: data.account_id || tokens.account_id,
    };
  }

  async _refresh(refreshToken) {
    const resp = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
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

  static _jwtExpiry(token) {
    try {
      const payload = token.split('.')[1];
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return (decoded.exp || 0) * 1000;
    } catch {
      return 0;
    }
  }

  async getValidToken() {
    const now = Date.now();

    // Check in-memory cache
    if (this._cachedToken && now < this._cachedExpiry - TOKEN_REFRESH_BUFFER_MS) {
      return { token: this._cachedToken, accountId: this._cachedAccount };
    }

    // If explicit tokens were provided, use those
    if (this._explicitToken) {
      const expiry = AuthManager._jwtExpiry(this._explicitToken);
      if (expiry > now + TOKEN_REFRESH_BUFFER_MS) {
        this._cachedToken = this._explicitToken;
        this._cachedExpiry = expiry;
        this._cachedAccount = this._explicitAccount;
        return { token: this._cachedToken, accountId: this._cachedAccount };
      }

      // Try refresh with explicit refresh token
      if (this._explicitRefresh) {
        const refreshed = await this._refresh(this._explicitRefresh);
        this._explicitToken = refreshed.accessToken;
        this._explicitRefresh = refreshed.refreshToken;
        this._cachedToken = refreshed.accessToken;
        this._cachedExpiry = now + refreshed.expiresIn * 1000;
        return { token: this._cachedToken, accountId: this._cachedAccount };
      }
    }

    // Load from codex auth file
    const auth = this._loadFromFile();

    // Check if file token is still valid
    const fileExpiry = AuthManager._jwtExpiry(auth.accessToken);
    if (fileExpiry > now + TOKEN_REFRESH_BUFFER_MS) {
      this._cachedToken = auth.accessToken;
      this._cachedExpiry = fileExpiry;
      this._cachedAccount = auth.accountId;
      return { token: this._cachedToken, accountId: this._cachedAccount };
    }

    // Refresh via OAuth
    const refreshed = await this._refresh(auth.refreshToken);

    // Write back to file
    try {
      const raw = readFileSync(this.authPath, 'utf-8');
      const data = JSON.parse(raw);
      data.tokens.access_token = refreshed.accessToken;
      data.tokens.refresh_token = refreshed.refreshToken;
      data.last_refresh = new Date().toISOString();
      writeFileSync(this.authPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Non-fatal
    }

    this._cachedToken = refreshed.accessToken;
    this._cachedExpiry = now + refreshed.expiresIn * 1000;
    this._cachedAccount = auth.accountId;
    return { token: this._cachedToken, accountId: this._cachedAccount };
  }
}

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

/**
 * @typedef {Object} SearchResult
 * @property {string} text - The search result text / answer
 * @property {string[]} searchQueries - The queries OpenAI actually searched for
 * @property {Object|null} usage - Token usage info
 * @property {string} model - The model used
 */

/**
 * @typedef {Object} SearchOptions
 * @property {'low'|'medium'|'high'} contextSize - How much web context to retrieve
 * @property {string} model - OpenAI model to use
 */

async function _callAPI(authManager, { input, tools, model }) {
  const { token, accountId } = await authManager.getValidToken();

  const resp = await fetch(API_URL, {
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
    }),
  });

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
   * @param {string} [opts.authPath] - Path to codex auth.json (default: ~/.codex/auth.json)
   * @param {string} [opts.accessToken] - Explicit access token (skip file loading)
   * @param {string} [opts.refreshToken] - Explicit refresh token
   * @param {string} [opts.accountId] - Explicit account ID
   * @param {string} [opts.model] - Default model (default: gpt-5.6-luna)
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
 * @param {SearchOptions} [opts]
 * @returns {Promise<SearchResult>}
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
 * @param {SearchOptions} [opts]
 * @returns {Promise<SearchResult>}
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

// Re-export AuthManager for advanced use
export { AuthManager };
export default OpenAIWebSearch;
