import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const mode = String(process.argv[2] || 'echo').trim();
const configuredSecret = String(process.argv[3] || '').trim();

const server = new McpServer({
  name: 'caff-f003-test-server',
  version: '1.0.0',
});

server.registerTool(
  'fixed_echo',
  {
    description: 'Isolated F003 stdio fixture.',
    inputSchema: {
      value: z.string(),
      projectScopeId: z.string(),
      traceId: z.string(),
      idempotencyKey: z.string(),
    },
  },
  async (input) => {
    if (mode === 'timeout') {
      await new Promise(() => {});
    }

    if (mode === 'disconnect') {
      process.exit(17);
    }

    if (mode === 'malformed') {
      return {
        content: [{ type: 'text', text: '{not-json' }],
      };
    }

    if (mode === 'secret') {
      return {
        content: [{ type: 'text', text: configuredSecret }],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            value: input.value,
            projectScopeId: input.projectScopeId,
            traceId: input.traceId,
            idempotencyKey: input.idempotencyKey,
          }),
        },
      ],
    };
  }
);

await server.connect(new StdioServerTransport());
