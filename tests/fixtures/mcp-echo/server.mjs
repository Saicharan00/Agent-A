#!/usr/bin/env node
// A tiny stdio MCP server for gateway tests (PLAN F35): one read tool (echo) and one write tool (save_note).
// Plain newline-delimited JSON-RPC, no dependencies. Test hooks: echo "__crash__" exits the process;
// echo "__key__" answers with the ECHO_API_KEY it was started with (the gateway must redact it).
import { createInterface } from 'node:readline';

const notes = [];
const tools = [
  {
    name: 'echo',
    description: 'Echoes the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'save_note',
    description: 'Saves a note (a write).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

function call(name, args) {
  if (name === 'echo') {
    if (args.text === '__crash__') process.exit(3);
    if (args.text === '__key__') return text(`key=${process.env.ECHO_API_KEY ?? ''}`);
    return text(`echo: ${args.text}`);
  }
  if (name === 'save_note') {
    notes.push(String(args.text));
    return text(`saved note #${notes.length}: ${args.text}`);
  }
  return { ...text(`Unknown tool ${name}`), isError: true };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications
  switch (req.method) {
    case 'initialize':
      return send({
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mcp-echo', version: '1.0.0' },
        },
      });
    case 'tools/list':
      return send({ id: req.id, result: { tools } });
    case 'tools/call':
      return send({ id: req.id, result: call(req.params?.name, req.params?.arguments ?? {}) });
    case 'ping':
      return send({ id: req.id, result: {} });
    default:
      return send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
