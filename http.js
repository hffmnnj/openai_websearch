/**
 * openai_websearch — HTTP (Streamable HTTP) transport for the MCP server.
 *
 * Mirrors the official MCP SDK Streamable HTTP pattern used by the
 * desktop's existing MCP fleet (brave-lite, context7, hugeicons).
 * Stateless: sessionIdGenerator is undefined, matching the fleet.
 */

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';

export function createApp({ token } = {}) {
  const app = express();
  app.use(express.json());

  // Bearer token protection (if configured)
  if (token) {
    app.use((req, res, next) => {
      // Health check stays open
      if (req.path === '/ping') return next();
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return res.status(401).json({
          id: null,
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' },
        });
      }
      next();
    });
  }

  app.all('/mcp', async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({
          id: null,
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
        });
      }
    }
  });

  app.get('/ping', (_, res) => res.json({ message: 'pong' }));

  return app;
}

export function startServer(port, host, { token } = {}) {
  createApp({ token }).listen(port, host, () => {
    console.error(`openai_websearch MCP on http://${host}:${port}/mcp${token ? ' (token protected)' : ''}`);
  });
}
