// A minimal stdio MCP server for tests. Every tools/call it actually receives is appended to FAKE_MCP_LOG,
// so a test can prove a blocked call never reached the server.
import { appendFileSync } from 'node:fs';

const TOOLS = [
  { name: 'list_pods', description: 'List pods', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'delete_namespace', description: 'Delete a namespace', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  { name: 'frobnicate', description: 'Unknown but declared destructive', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  { name: 'run_command', description: 'Run a shell command', inputSchema: { type: 'object' } },
  { name: 'flaky', description: 'Always fails', inputSchema: { type: 'object' } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    else if (m.method === 'tools/call') {
      if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${m.params.name}\n`);
      if (m.params.name === 'flaky') send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
      else send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ran ${m.params.name}` }] } });
    } else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
