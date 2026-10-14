// Memories for the UI (F22): bot memory tabs and the Shared Knowledge page.
import {
  type MemoryCreateRequest,
  type MemoryScope,
  type MemoryUpdateRequest,
  memoryViewSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

const enc = encodeURIComponent;

export type MemoryFilter = { scope: MemoryScope; botId?: string; q?: string };

export const memoriesApi = {
  list: (f: MemoryFilter) =>
    apiRequest('/memories', z.array(memoryViewSchema), { query: { ...f, q: f.q?.trim() || undefined } }),
  create: (body: MemoryCreateRequest) => apiRequest('/memories', memoryViewSchema, { method: 'POST', body }),
  update: (id: string, body: MemoryUpdateRequest) =>
    apiRequest(`/memories/${enc(id)}`, memoryViewSchema, { method: 'PATCH', body }),
  delete: (id: string) => apiRequest(`/memories/${enc(id)}`, z.unknown(), { method: 'DELETE' }),
};

/** "a, b ,, c" → ["a", "b", "c"] (at most 10, as the API allows). */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);
}
