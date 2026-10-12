import { z } from 'zod';

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  uptime: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
