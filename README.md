# openai_websearch

Self-hostable **MCP server** (official `@modelcontextprotocol/sdk`) and **reusable API client** that exposes OpenAI's native server-side web search via the ChatGPT/Codex Responses API.

**No API keys required.** Authenticate with your ChatGPT account in 3 ways:

1. **Browser OAuth** — gets a URL, you click Connect (works on any device)
2. **Device-code flow** — URL + code for headless/remote machines (no browser needed)
3. **Existing Codex auth** — auto-falls back to `~/.codex/auth.json`

Tokens **auto-refresh** — no manual re-login every few weeks.

## Features

| Capability | Description |
|---|---|
| `web_search` | Full-text web search with real URLs and citations |
| `image_search` | Image search returning web image URLs and source pages |
| **Built-in OAuth login** | `node index.js login` or `--device-code` — no Codex install needed |
| **Auto-refreshing tokens** | `refresh_token` grant, stores in `~/.openai-websearch/auth.json` |
| **Official MCP SDK** | `@modelcontextprotocol/sdk` — proper protocol handshake, Zod schemas, JSON Schema output |
| **Reusable library** | Import in any Node/Bun/Deno project |
| **Zero API keys** | Uses your ChatGPT subscription |

---

## As an MCP server

### Install & authenticate

```bash
git clone https://github.com/hffmnnj/openai_websearch.git
cd openai_websearch
npm install

# Authenticate (browser flow — prints a URL)
node index.js login

# Or headless (prints URL + code, enter on any device)
node index.js login --device-code

# Check auth status
node index.js auth-status
```

### Configure your MCP client

```json
{
  "mcpServers": {
    "openai_websearch": {
      "command": "node",
      "args": ["/path/to/openai_websearch/index.js"]
    }
  }
}
```

### Tools

| Tool | Args | Description |
|------|------|-------------|
| `web_search` | `query` (required), `context_size` (`low`/`medium`/`high`), `model` | Text web search with real URLs |
| `image_search` | `query` (required), `context_size`, `model` | Image search returning URLs + source pages |

---

## As a library (NPM package)

### Install

```bash
npm install github:hffmnnj/openai_websearch
```

### Quick start

```javascript
import { search, imageSearch } from 'openai_websearch';

// Web search
const results = await search('smart ring market size 2026');
console.log(results.text);
console.log(results.searchQueries);  // queries OpenAI actually ran
console.log(results.usage);          // token counts

// Image search
const images = await imageSearch('oura ring product photos');
console.log(images.text);            // URLs and descriptions
```

### Explicit auth (no Codex, no login prompt — pass tokens directly)

```javascript
import { createClient } from 'openai_websearch';

const client = createClient({
  accessToken: 'eyJhbG...',     // JWT from your own OAuth flow
  refreshToken: 'rt.1.AAB...',  // auto-refreshes when expired
  accountId: 'uuid-here',
});

const result = await client.search('test query');
```

### Full OAuth in your own code

```javascript
import { authenticateBrowser, authenticateDeviceCode, createClient } from 'openai_websearch';

// Browser flow
const { tokens, authorizeUrl } = await authenticateBrowser();
// → user opens authorizeUrl, clicks Connect

// Device-code flow (headless)
const { tokens, verificationUrl, userCode } = await authenticateDeviceCode();
// → user visits verificationUrl, enters userCode

// Then use the tokens
const client = createClient({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
});
```

### API reference

#### `search(query, opts?)` / `client.search(query, opts?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `string` | *required* | What to search for |
| `opts.contextSize` | `'low' \| 'medium' \| 'high'` | `'medium'` | Web context to retrieve |
| `opts.model` | `string` | `'gpt-5.6-luna'` | OpenAI model |

Returns `{ text, searchQueries, usage, model }`.

#### `createClient(opts?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `opts.authPath` | `string` | `~/.openai-websearch/auth.json` | Auth file location |
| `opts.accessToken` | `string` | — | Explicit JWT |
| `opts.refreshToken` | `string` | — | Auto-refresh when expired |
| `opts.accountId` | `string` | — | ChatGPT account ID |
| `opts.fallbackToCodex` | `boolean` | `true` | Fall back to `~/.codex/auth.json` |
| `opts.model` | `string` | `'gpt-5.6-luna'` | Default model |

#### Auth helpers (from `openai_websearch/auth`)

| Export | Description |
|--------|-------------|
| `authenticateBrowser({ timeoutMs })` | PKCE browser flow, callback on `localhost:1455` |
| `authenticateDeviceCode({ pollInterval, timeoutMs })` | Headless flow, returns URL + code |
| `refreshTokens(refreshToken)` | Refresh grant |
| `AuthManager` | Load/refresh/save token management |

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `OPENAI_WEBSEARCH_AUTH_FILE` | `~/.openai-websearch/auth.json` | Auth file path |
| `OPENAI_WEBSEARCH_MODEL` | `gpt-5.6-luna` | Default model |
| `CODEX_AUTH_PATH` | `~/.codex/auth.json` | Fallback Codex auth file |

## Requirements

- Node.js 18+ (native `fetch`), Bun, or Deno
- A ChatGPT account (free/plus/pro — whatever you have)
- **No Codex CLI required** (unless you want the fallback auth)

## How it works

1. **Auth:** OAuth2 with PKCE against `auth.openai.com` (same client as Codex CLI). Browser flow or device-code flow. Tokens stored locally, refreshed automatically via `refresh_token` grant.
2. **Search:** Sends requests to the ChatGPT backend Responses API (`chatgpt.com/backend-api/codex/responses`) with the `web_search` tool.
3. **MCP:** The server uses the official `@modelcontextprotocol/sdk` — proper JSON-RPC framing, protocol version negotiation, Zod → JSON Schema derivation, argument validation.

All search runs **server-side at OpenAI** — same infrastructure that powers ChatGPT's web search.

## License

MIT
