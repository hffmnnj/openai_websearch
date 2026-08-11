/**
 * openai_websearch — MCP server factory (shared by stdio and HTTP transports).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OpenAIWebSearch } from './lib/index.js';

export function createMcpServer() {
  const server = new McpServer(
    { name: 'openai_websearch', version: '1.2.0' },
    { capabilities: { tools: { listChanged: false } } }
  );

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
