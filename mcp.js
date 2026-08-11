/**
 * openai_websearch — MCP server factory (shared by stdio and HTTP transports).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OpenAIWebSearch } from './lib/index.js';

/**
 * Strip tracking params (utm_*) from URLs to cut token bloat.
 * e.g. https://x.com/path?utm_source=openai → https://x.com/path
 */
function stripUtm(text) {
  return text
    .replace(/[?&]utm_[a-z0-9_]+=[^&\s)]*/gi, '')
    .replace(/[?&]+$/g, '');
}

export function createMcpServer() {
  const server = new McpServer(
    { name: 'openai_websearch', version: '1.2.1' },
    { capabilities: { tools: { listChanged: false } } }
  );

  const client = new OpenAIWebSearch();

  server.registerTool(
    'web_search',
    {
      title: 'Web Search',
      description: `Search the web using OpenAI's native server-side web search. Returns clean, up-to-date results with real URLs and citations. Powered by your ChatGPT/Codex subscription.
- contextSize: "low" (fast/cheap), "medium" (balanced, default), "high" (thorough/deep)
- All search happens server-side at OpenAI, not locally`,
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
      return { content: [{ type: 'text', text: stripUtm(result.text || '') }] };
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
      return { content: [{ type: 'text', text: stripUtm(result.text || '') }] };
    },
  );

  return server;
}
