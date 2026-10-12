// pnpm mock:run "[mock:tools] hello" → prints the mock engine's normalized events, one JSON per line.
import { MockEngine } from '../src/engines/mock';

const prompt = process.argv.slice(2).join(' ') || '[mock:hello]';
const ac = new AbortController();
process.on('SIGINT', () => ac.abort());
const engine = new MockEngine();
const input = {
  bot: { id: 'bot_demo', name: 'Demo Bot', slug: 'demo-bot', role: '', engine: 'mock' as const, model: null },
  threadId: 'thr_demo',
  prompt,
  systemPromptAppend: '',
  mcpConfigPath: '/home/bot/.agenta/mcp.json',
  cwd: '/home/bot/work',
};
for await (const event of engine.run(input, ac.signal)) console.log(JSON.stringify(event));
