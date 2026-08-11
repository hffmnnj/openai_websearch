# openai_websearch

Self-hostable MCP server that exposes **OpenAI's native server-side web search** through the ChatGPT/Codex Responses API.

Uses your existing **Codex CLI** auth (ChatGPT subscription) — no API keys, no Exa, no third-party search services.

## Features

- **`web_search`** — Full-text web search with real URLs and citations
- **`image_search`** — Image search returning web image URLs and source pages
- **Auto-refreshing OAuth tokens** — reads from `~/.codex/auth.json`, refreshes automatically
- **Zero dependencies** — pure Node.js stdlib, MCP over stdio
- **Configurable** — choose model, context size, search depth

## Requirements

- Node.js 18+ (for native `fetch`)
- Codex CLI installed and authenticated (`codex` → log in with ChatGPT)

## Installation

```bash
git clone https://github.com/hffmnnj/openai_websearch.git
cd openai_websearch
npm install  # no deps, just links the bin
```

## Usage

### Standalone (test it)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node index.js
```

### As an MCP server

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

### Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `CODEX_AUTH_PATH` | `~/.codex/auth.json` | Path to Codex auth file |
| `OPENAI_WEBSEARCH_MODEL` | `gpt-5.4` | Default OpenAI model |

## How it works

1. Reads OAuth tokens from `~/.codex/auth.json` (where Codex CLI stores them)
2. If token is expired, refreshes using the OpenAI OAuth endpoint
3. Sends search requests to `https://chatgpt.com/backend-api/codex/responses` with `{"type": "web_search"}` tool
4. Parses SSE stream, extracts search queries, text results, and image URLs
5. Returns clean MCP tool responses

All search runs **server-side at OpenAI** — same infrastructure that powers ChatGPT's web search.

## License

MIT
