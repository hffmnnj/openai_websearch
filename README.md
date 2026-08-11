# openai_websearch

Self-hostable **MCP server** and **reusable API client** that exposes OpenAI's native server-side web search via the Codex/ChatGPT Responses API.

Uses your existing **Codex CLI** auth (ChatGPT subscription) — no API keys, no Exa, no Brave, no third-party search services. Zero dependencies.

## Two ways to use this

1. **MCP server** — drop into any MCP-compatible client (Hermes, OpenCode, Claude Code, etc.)
2. **NPM package** — import as a library in any Node.js/Bun/Deno project for free web search

---

## As an MCP server

### Tools

| Tool | Description |
|------|-------------|
| `web_search` | Full-text web search with real URLs, citations, and configurable depth |
| `image_search` | Image search returning image URLs and source pages |

### Config

Add to your MCP client config:

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

---

## As a library (NPM package)

### Install

```bash
# Local install from repo
git clone https://github.com/hffmnnj/openai_websearch.git
cd openai_websearch && npm link

# Or add as a dependency in package.json
"dependencies": {
  "openai_websearch": "github:hffmnnj/openai_websearch"
}
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

### Advanced usage

```javascript
import { createClient } from 'openai_websearch';

// Custom client with explicit options
const client = createClient({
  model: 'gpt-5.6-luna',           // default model
  authPath: '/custom/auth.json',   // custom codex auth path
});

// Use per-call options
const fast = await client.search('quick fact', { contextSize: 'low' });
const deep = await client.search('thorough research', { contextSize: 'high', model: 'gpt-5.6-luna' });
const imgs = await client.imageSearch('competitor screenshots');
```

### Explicit auth (no codex file needed)

```javascript
const client = createClient({
  accessToken: 'eyJhbG...',     // raw JWT
  refreshToken: 'rt.1.AAB...',  // for auto-refresh
  accountId: 'uuid-here',
});

const result = await client.search('test query');
```

### API reference

#### `search(query, opts?)` / `client.search(query, opts?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `string` | *required* | What to search for |
| `opts.contextSize` | `'low' \| 'medium' \| 'high'` | `'medium'` | How much web context to retrieve |
| `opts.model` | `string` | `'gpt-5.6-luna'` | OpenAI model to use |

Returns `{ text, searchQueries, usage, model }`.

#### `imageSearch(query, opts?)` / `client.imageSearch(query, opts?)`

Same params as `search()`. Returns image URLs and source pages.

#### `createClient(opts?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `opts.authPath` | `string` | `~/.codex/auth.json` | Path to Codex auth file |
| `opts.accessToken` | `string` | — | Explicit JWT (skip file loading) |
| `opts.refreshToken` | `string` | — | For auto-refresh |
| `opts.accountId` | `string` | — | ChatGPT account ID |
| `opts.model` | `string` | `'gpt-5.6-luna'` | Default model |

#### Result shape

```typescript
{
  text: string;              // The answer / search results
  searchQueries: string[];   // Queries OpenAI actually searched for
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  model: string;             // Model used for this request
}
```

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `CODEX_AUTH_PATH` | `~/.codex/auth.json` | Path to Codex auth file |
| `OPENAI_WEBSEARCH_MODEL` | `gpt-5.6-luna` | Default OpenAI model |

## Requirements

- Node.js 18+ (for native `fetch`), Bun, or Deno
- Codex CLI installed and authenticated (`codex` → log in with ChatGPT)

## How it works

1. Reads OAuth tokens from `~/.codex/auth.json` (where Codex CLI stores them)
2. If token is expired, refreshes via the OpenAI OAuth endpoint automatically
3. Sends search requests to the ChatGPT backend Responses API with `{"type": "web_search"}`
4. Parses SSE stream, extracts search queries and results
5. Returns structured results (as a library) or MCP tool responses (as a server)

All search runs **server-side at OpenAI** — same infrastructure that powers ChatGPT's web search.

## License

MIT
