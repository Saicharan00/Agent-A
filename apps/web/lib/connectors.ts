// Connectors (F29): which bots may use GitHub. Tokens never reach the browser, only whether one is set.
import { type ConnectorPatch, connectorViewSchema } from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

export const connectorsApi = {
  list: () => apiRequest('/connectors', z.array(connectorViewSchema)),
  update: (id: string, body: ConnectorPatch) =>
    apiRequest(`/connectors/${encodeURIComponent(id)}`, connectorViewSchema, { method: 'PATCH', body }),
};
