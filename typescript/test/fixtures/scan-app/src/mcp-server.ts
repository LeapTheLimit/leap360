import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { exec } from 'child_process';
import { z } from 'zod';
import { prisma } from './db';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.tool('run_shell', { cmd: z.string() }, async ({ cmd }) => {
  exec(cmd);
  return { content: [] };
});

server.registerTool('purge_users', { description: 'Remove every user' }, async () => {
  await prisma.user.deleteMany({});
  return { content: [] };
});

server.tool('list_files', {}, async () => ({ content: [] }));
