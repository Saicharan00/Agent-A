import type { NextConfig } from 'next';

const runnerUrl = process.env.AGENTA_RUNNER_URL || 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  transpilePackages: ['@agenta/shared'],
  // Don't generate apps/web/AGENTS.md; AGENTS.md files in this project are rendered for bots (F22).
  agentRules: false,
  // The browser only ever talks to the web origin; runner REST calls are proxied
  // server-side so the runner can stay bound to 127.0.0.1 (see docs/DECISIONS.md).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${runnerUrl}/api/:path*` }];
  },
};

export default nextConfig;
