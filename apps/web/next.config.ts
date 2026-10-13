import type { NextConfig } from 'next';

const runnerUrl = process.env.AGENTA_RUNNER_URL || 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  transpilePackages: ['@agenta/shared'],
  // Don't generate apps/web/AGENTS.md; AGENTS.md files in this project are rendered for bots (F22).
  agentRules: false,
  // With AGENTA_WEB_HOST=0.0.0.0, Next treats 127.0.0.1 as a cross-origin dev client and blocks
  // its hot-reload socket (/_next/hmr). Dev-only setting; production ignores it.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // The floating dev badge covers the sidebar footer; build errors still show as an overlay.
  devIndicators: false,
  // The browser only ever talks to the web origin; runner REST calls are proxied
  // server-side so the runner can stay bound to 127.0.0.1 (see docs/DECISIONS.md).
  async rewrites() {
    // /ws (live events, F11) goes the same way: Next proxies the WebSocket upgrade to the runner.
    return [
      { source: '/api/:path*', destination: `${runnerUrl}/api/:path*` },
      { source: '/ws', destination: `${runnerUrl}/ws` },
    ];
  },
};

export default nextConfig;
