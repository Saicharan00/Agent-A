// Confidentiality guard (F24): pre-send checks and the owner's guard terms.
import { type GuardTermCreateInput, guardCheckResponseSchema, guardTermViewSchema } from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

export const guardApi = {
  check: (text: string) =>
    apiRequest('/guard/check', guardCheckResponseSchema, { method: 'POST', body: { text } }),
  terms: () => apiRequest('/guard/terms', z.array(guardTermViewSchema)),
  createTerm: (body: GuardTermCreateInput) =>
    apiRequest('/guard/terms', guardTermViewSchema, { method: 'POST', body }),
  deleteTerm: (id: string) =>
    apiRequest(`/guard/terms/${encodeURIComponent(id)}`, z.unknown(), { method: 'DELETE' }),
};
