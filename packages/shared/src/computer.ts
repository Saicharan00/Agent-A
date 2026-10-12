import { z } from 'zod';
import { BOT_STATUSES } from './enums';

// Bot computer (container) API shapes: F05 routes under /api/bots/:id/computer.

export const BOT_IMAGE = 'agenta-bot:latest';
export const BOT_NETWORK = 'agenta-net';
/** Port the noVNC/websockify server listens on inside every bot container. */
export const NOVNC_CONTAINER_PORT = 6080;

export const computerStatusSchema = z.object({
  botId: z.string(),
  status: z.enum(BOT_STATUSES),
  containerId: z.string().nullable(),
  novncPort: z.number().int().nullable(),
  /** Docker health of the desktop (noVNC), when the container exists. */
  health: z.enum(['starting', 'healthy', 'unhealthy', 'none']).nullable(),
});
export type ComputerStatus = z.infer<typeof computerStatusSchema>;

export const computerResetSchema = z
  .object({
    /** false (default): recreate the container, keep /home/bot. true: also erase the home. */
    wipeHome: z.boolean().default(false),
    /** Must be `true` when wipeHome is true. */
    confirm: z.boolean().optional(),
  })
  .refine((b) => !b.wipeHome || b.confirm === true, {
    message: 'Wiping the home folder requires "confirm": true',
    path: ['confirm'],
  });
export type ComputerResetInput = z.input<typeof computerResetSchema>;

/** Bot status changes, published on the `bot:<id>` channel. */
export const botStatusEventSchema = z.object({
  type: z.literal('bot.status'),
  botId: z.string(),
  status: z.enum(BOT_STATUSES),
  message: z.string().optional(),
});
export type BotStatusEvent = z.infer<typeof botStatusEventSchema>;
