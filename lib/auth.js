/**
 * openai_websearch — OAuth authentication module.
 *
 * Implements the same ChatGPT OAuth flow used by Codex CLI and gpt-image:
 *   - Browser redirect flow (PKCE, callback on localhost:1455)
 *   - Device-code flow (URL + code for headless/remote machines)
 *   - Automatic token refresh (refresh_token grant)
 *
 * Tokens are stored in ~/.openai-websearch/auth.json (or OPENAI_WEBSEARCH_AUTH_FILE).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUTH_URL = 'https://auth.openai.com';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = '/auth/callback';
export const DEVICE_CALLBACK = `${AUTH_URL}/deviceauth/callback`;

export const SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

export function defaultAuthPath() {
  return process.env.OPENAI_WEBSEARCH_AUTH_FILE
    || join(homedir(), '.openai-websearch', 'auth.json');
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

export function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateState() {
  return randomBytes(16).toString('base64url');
}

// ─── Token helpers ────────────────────────────────────────────────────────────

export function jwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return (decoded.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

export function inferAccountId(accessToken) {
  try {
    const payload = accessToken.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return decoded['https://api.openai.com/auth']?.user_id
      || decoded.user_id
      || decoded.sub
      || null;
  } catch {
    return null;
  }
}

// ─── Auth file ────────────────────────────────────────────────────────────────

export function loadAuthFile(path = defaultAuthPath()) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveAuthFile(tokens, { idToken, accountId, path = defaultAuthPath() } = {}) {
  const existing = loadAuthFile(path) || {};
  const data = {
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(idToken ? { id_token: idToken } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  try { chmodSync(path, 0o600); } catch {}
  return path;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function postForm(url, payload, headers = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'openai-websearch/1.2.0',
      ...headers,
    },
    body: new URLSearchParams(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function postJson(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'openai-websearch/1.2.0',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ─── Browser redirect flow ────────────────────────────────────────────────────

/**
 * Build the authorize URL for the browser redirect flow.
 * Users open this URL in any browser (including on their phone).
 */
export function buildAuthorizeUrl({ state = generateState(), challenge, redirectUri } = {}) {
  return buildAuthorizeUrlInternal({ state, challenge, redirectUri });
}

function buildAuthorizeUrlInternal({ state, challenge, redirectUri }) {
  redirectUri = redirectUri || `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  });
  return `${AUTH_URL}/oauth/authorize?${params.toString()}`;
}

/**
 * Start a local HTTP server that waits for the OAuth callback.
 * Returns { server, url, promise } — promise resolves with the auth code.
 */
export function startCallbackServer(port = CALLBACK_PORT) {
  const result = { code: null, error: null };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === CALLBACK_PATH) {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (code) result.code = code;
      if (error) result.error = error;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Authentication complete</h2><p>You can close this window and return to the terminal.</p></body></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        result,
        url: `http://localhost:${port}${CALLBACK_PATH}`,
      });
    });
  });
}

/**
 * Full browser flow: starts callback server, builds authorize URL,
 * waits for the code, exchanges it for tokens.
 *
 * @returns {Promise<{tokens: object, authorizeUrl: string}>}
 */
export async function authenticateBrowser({ timeoutMs = 5 * 60 * 1000, printUrl = true } = {}) {
  const { verifier, challenge } = generatePkce();
  const state = generateState();

  const { server, result } = await startCallbackServer();
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const authorizeUrl = buildAuthorizeUrlInternal({ state, challenge, redirectUri });

  if (printUrl) {
    console.log('Open this URL in your browser and sign in with ChatGPT:');
    console.log(`  ${authorizeUrl}`);
    console.log('Waiting for callback...');
  }

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (result.code) break;
      if (result.error) throw new Error(`OAuth error: ${result.error}`);
      await new Promise(r => setTimeout(r, 200));
    }
    if (!result.code) throw new Error('Browser authentication timed out.');

    const data = await postForm(`${AUTH_URL}/oauth/token`, {
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    });

    return { tokens: data, authorizeUrl };
  } finally {
    server.close();
  }
}

// ─── Device-code flow ─────────────────────────────────────────────────────────

/**
 * Start a device-code flow. Returns the URL + code to show the user,
 * plus a promise that resolves with tokens once they authorize.
 */
export async function authenticateDeviceCode({ pollInterval = 5, timeoutMs = 15 * 60 * 1000, printUrl = true } = {}) {
  const data = await postJson(`${AUTH_URL}/api/accounts/deviceauth/usercode`, {
    client_id: CLIENT_ID,
  });

  const deviceAuthId = data.device_auth_id || data.deviceAuthId;
  const userCode = data.user_code || data.usercode;
  const interval = Math.max(1, parseInt(data.interval || pollInterval, 10));
  const verificationUrl = `${AUTH_URL}/codex/device`;

  if (!deviceAuthId || !userCode) {
    throw new Error('Device-code response missing required fields.');
  }

  if (printUrl) {
    console.log('Open this URL in your browser and enter the code:');
    console.log(`  URL:  ${verificationUrl}`);
    console.log(`  Code: ${userCode}`);
    console.log('Waiting for authorization...');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const poll = await postJson(`${AUTH_URL}/api/accounts/deviceauth/token`, {
        device_auth_id: deviceAuthId,
        user_code: userCode,
      });
      const authCode = poll.authorization_code;
      const codeVerifier = poll.code_verifier;
      if (authCode && codeVerifier) {
        const tokens = await postForm(`${AUTH_URL}/oauth/token`, {
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: DEVICE_CALLBACK,
          client_id: CLIENT_ID,
          code_verifier: codeVerifier,
        });
        return { tokens, verificationUrl, userCode };
      }
    } catch (e) {
      // 403/404 = not yet authorized, keep polling
      if (!String(e.message).includes('HTTP 403') && !String(e.message).includes('HTTP 404')) {
        throw e;
      }
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }

  throw new Error('Device authorization timed out.');
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export async function refreshTokens(refreshToken) {
  const data = await postForm(`${AUTH_URL}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  return data;
}

// ─── High-level auth manager ──────────────────────────────────────────────────

/**
 * AuthManager handles: load from auth file (own file first, then ~/.codex/auth.json),
 * refresh when expired, and save back. Also supports explicit token injection.
 */
export class AuthManager {
  constructor({
    authPath,
    accessToken,
    refreshToken,
    accountId,
    fallbackToCodex = true,
  } = {}) {
    this.authPath = authPath || defaultAuthPath();
    this.fallbackToCodex = fallbackToCodex;
    this._explicit = accessToken ? {
      accessToken,
      refreshToken: refreshToken || null,
      accountId: accountId || null,
    } : null;
    this._cache = null;
  }

  /** Token expiry buffer: refresh 5 min early */
  static BUFFER_MS = 5 * 60 * 1000;

  _loadFromFile() {
    const data = loadAuthFile(this.authPath);
    if (data?.tokens?.access_token) return data;
    if (this.fallbackToCodex) {
      const codexPath = process.env.CODEX_AUTH_PATH || join(homedir(), '.codex', 'auth.json');
      const codexData = loadAuthFile(codexPath);
      if (codexData?.tokens?.access_token) {
        return {
          ...codexData,
          _source: 'codex',
          _path: codexPath,
        };
      }
    }
    return null;
  }

  async getValidToken() {
    const now = Date.now();

    // In-memory cache valid?
    if (this._cache && now < this._cache.expiry - AuthManager.BUFFER_MS) {
      return this._cache;
    }

    // Explicit tokens
    if (this._explicit) {
      const expiry = jwtExpiry(this._explicit.accessToken);
      if (expiry > now + AuthManager.BUFFER_MS) {
        this._cache = {
          token: this._explicit.accessToken,
          accountId: this._explicit.accountId,
          expiry,
        };
        return this._cache;
      }
      if (this._explicit.refreshToken) {
        const refreshed = await refreshTokens(this._explicit.refreshToken);
        this._explicit.accessToken = refreshed.access_token;
        this._explicit.refreshToken = refreshed.refresh_token || this._explicit.refreshToken;
        this._cache = {
          token: refreshed.access_token,
          accountId: this._explicit.accountId,
          expiry: now + (refreshed.expires_in || 864000) * 1000,
        };
        return this._cache;
      }
      throw new Error('Access token expired and no refresh token available.');
    }

    // Auth file
    const auth = this._loadFromFile();
    if (!auth) {
      throw new Error(
        `No auth found. Run 'node index.js login' (or 'login --device-code') to authenticate.`
      );
    }

    const accessToken = auth.tokens.access_token;
    const refreshToken = auth.tokens.refresh_token;
    const accountId = auth.tokens.account_id || null;
    const expiry = jwtExpiry(accessToken);

    // Still valid?
    if (expiry > now + AuthManager.BUFFER_MS) {
      this._cache = { token: accessToken, accountId, expiry };
      return this._cache;
    }

    // Need refresh
    if (!refreshToken) {
      throw new Error('Access token expired and no refresh token available. Re-run login.');
    }
    const refreshed = await refreshTokens(refreshToken);
    const newExpiry = now + (refreshed.expires_in || 864000) * 1000;

    // Save back to our own auth file (never touch codex's)
    if (auth._source === 'codex') {
      saveAuthFile({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || refreshToken,
      }, {
        accountId,
        path: this.authPath,
      });
    } else {
      saveAuthFile({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || refreshToken,
      }, {
        accountId,
        path: this.authPath,
      });
    }

    this._cache = {
      token: refreshed.access_token,
      accountId,
      expiry: newExpiry,
    };
    return this._cache;
  }
}
