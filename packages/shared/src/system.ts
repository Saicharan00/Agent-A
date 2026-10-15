// Onboarding, app settings, the doctor and the bot image build (F31).
import { z } from 'zod';
import { botSettingsSchema } from './dto';
import { DEFAULT_SCHEDULE_TIMEZONE, isValidTimeZone } from './schedules';

// ---------- doctor ----------
export const DOCTOR_STATUSES = ['ok', 'warn', 'fail'] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export const doctorCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(DOCTOR_STATUSES),
  summary: z.string(),
  /** Steps that fix a warn/fail, in order. */
  fix: z.array(z.string()).default([]),
});
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const doctorReportSchema = z.object({
  /** No check failed (warnings allowed). */
  ok: z.boolean(),
  insideSandbox: z.boolean(),
  checks: z.array(doctorCheckSchema),
  generatedAt: z.string(),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

// ---------- app settings ----------
export const botDefaultsSchema = botSettingsSchema.pick({ cpus: true, memoryMb: true, idleTimeoutMin: true });
export type BotDefaults = z.infer<typeof botDefaultsSchema>;

export const appSettingsUpdateSchema = z.object({
  /** Default time zone for new schedules. */
  timezone: z.string().min(1).max(100).refine(isValidTimeZone, 'Unknown time zone').optional(),
  /** Resource limits new bots (and newly created team bots) start with. */
  botDefaults: botDefaultsSchema.optional(),
});
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;

export const appSettingsSchema = z.object({
  timezone: z.string(),
  botDefaults: botDefaultsSchema,
  /** Where the data lives, read-only (absolute paths inside the sandbox VM). */
  paths: z.object({
    data: z.string(),
    db: z.string(),
    bots: z.string(),
    shared: z.string(),
    secrets: z.string(),
    backups: z.string(),
  }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_APP_TIMEZONE = DEFAULT_SCHEDULE_TIMEZONE;
export const DEFAULT_BOT_DEFAULTS: BotDefaults = botDefaultsSchema.parse(botSettingsSchema.parse({}));

// ---------- bot image build ----------
export const IMAGE_BUILD_STATES = ['idle', 'running', 'succeeded', 'failed'] as const;
export const imageBuildStatusSchema = z.object({
  state: z.enum(IMAGE_BUILD_STATES),
  /** The last lines of the build output. */
  log: z.array(z.string()),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
});
export type ImageBuildStatus = z.infer<typeof imageBuildStatusSchema>;

// ---------- onboarding ----------
export const onboardingTeamResponseSchema = z.object({
  created: z.array(z.string()),
  leadRoomId: z.string(),
  /** Agent A's DM, where the hello was sent. */
  leadThreadId: z.string(),
});
export type OnboardingTeamResponse = z.infer<typeof onboardingTeamResponseSchema>;

export const ONBOARDING_HELLO =
  'Hello Agent A! I just set up the team. Please introduce yourself and the team in a few lines, and suggest a good first goal for us.';
