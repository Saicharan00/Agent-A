// MCP gateway (F35): external MCP servers, which bots may use them, and the web research setting.
// Secret values never reach the browser: servers reference .env.local variables by name.
import {
  type BotMcpAccessInput,
  type McpServerCreateInput,
  type McpServerUpdateInput,
  type WebAccessMode,
  botMcpAccessViewSchema,
  mcpOAuthStartSchema,
  mcpServerViewSchema,
  researchSettingsViewSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

const path = (id: string) => `/mcp-servers/${encodeURIComponent(id)}`;

export const mcpApi = {
  list: () => apiRequest('/mcp-servers', z.array(mcpServerViewSchema)),
  create: (server: McpServerCreateInput, grantTo?: 'specialists' | 'all') =>
    apiRequest('/mcp-servers', mcpServerViewSchema, { method: 'POST', body: { server, grantTo } }),
  update: (id: string, patch: McpServerUpdateInput) =>
    apiRequest(path(id), mcpServerViewSchema, { method: 'PATCH', body: patch }),
  remove: (id: string) => apiRequest(path(id), z.unknown(), { method: 'DELETE' }),
  test: (id: string) => apiRequest(`${path(id)}/test`, mcpServerViewSchema, { method: 'POST' }),
  oauthStart: (id: string) => apiRequest(`${path(id)}/oauth`, mcpOAuthStartSchema, { method: 'POST' }),
  oauthSignOut: (id: string) => apiRequest(`${path(id)}/oauth`, mcpServerViewSchema, { method: 'DELETE' }),
  access: (botId: string) =>
    apiRequest(`/bots/${encodeURIComponent(botId)}/mcp-access`, z.array(botMcpAccessViewSchema)),
  setAccess: (botId: string, access: BotMcpAccessInput[]) =>
    apiRequest(`/bots/${encodeURIComponent(botId)}/mcp-access`, z.array(botMcpAccessViewSchema), {
      method: 'PUT',
      body: { access },
    }),
  research: () => apiRequest('/research/settings', researchSettingsViewSchema),
  setResearch: (webAccess: WebAccessMode) =>
    apiRequest('/research/settings', researchSettingsViewSchema, { method: 'PUT', body: { webAccess } }),
};
