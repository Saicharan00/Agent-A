import { z } from 'zod';
import { CONNECTOR_TYPES } from './enums';

/** A connector as the Settings page shows it (F29). Never carries the token, only whether one is set. */
export const connectorViewSchema = z.object({
  id: z.string(),
  type: z.enum(CONNECTOR_TYPES),
  enabled: z.boolean(),
  /** The .env.local variable that holds the token (GITHUB_TOKEN), if this type uses one. */
  tokenEnv: z.string().nullable(),
  tokenPresent: z.boolean(),
  /** Bots allowed to use it. */
  botIds: z.array(z.string()),
  createdAt: z.string(),
});
export type ConnectorView = z.infer<typeof connectorViewSchema>;

export const connectorPatchSchema = z
  .object({ enabled: z.boolean(), botIds: z.array(z.string().min(1)).max(500) })
  .partial();
export type ConnectorPatch = z.input<typeof connectorPatchSchema>;
