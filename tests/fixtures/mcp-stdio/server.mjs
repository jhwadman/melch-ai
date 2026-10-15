// A stdio MCP server for tests/mcpStdio.test.ts: one tool that reports the
// process it runs in and which of the test's variables it can see.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-fixture', version: '0.0.0' });
server.registerTool('stdio_whoami', {
  description: 'Reports the server process and the variables it was given.',
  inputSchema: { note: z.string().optional() },
}, async ({ note }) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(),
      passed: process.env.STDIO_TEST_PASSED ?? null,
      hidden: process.env.STDIO_TEST_HIDDEN ?? null,
      literal: process.env.STDIO_TEST_MODE ?? null,
      note: note ?? null,
    }),
  }],
}));
server.registerTool('stdio_unlisted', { description: 'Not named by the test agent.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'should not be reachable' }] }));
await server.connect(new StdioServerTransport());
