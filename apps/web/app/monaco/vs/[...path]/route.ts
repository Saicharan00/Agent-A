// Serves Monaco's prebuilt AMD files (monaco-editor/min/vs) from node_modules, so the editor never loads from a CDN
// (the sandbox blocks most outbound hosts and the app should work offline).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function monacoDir(): string | null {
  // node_modules is hoisted to the repo root (.npmrc node-linker=hoisted); apps/web is the cwd.
  for (const base of [process.cwd(), join(process.cwd(), '..', '..')]) {
    const dir = join(base, 'node_modules', 'monaco-editor', 'min', 'vs');
    if (existsSync(dir)) return realpathSync(dir);
  }
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const root = monacoDir();
  if (!root || path.some((s) => s === '..' || s.includes('\0')))
    return new Response('Not found', { status: 404 });
  const file = join(root, ...path);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(readFileSync(file), {
    headers: {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    },
  });
}
