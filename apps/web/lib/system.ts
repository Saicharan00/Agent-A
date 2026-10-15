// Onboarding wizard, Settings → General / Health check, bot image build (F31).
import {
  type AppSettingsUpdate,
  type DoctorStatus,
  appSettingsSchema,
  doctorReportSchema,
  imageBuildStatusSchema,
  onboardingTeamResponseSchema,
} from '@agenta/shared';
import type { PillTone } from '@/components/status-pill';
import { apiRequest } from './api';

export const systemApi = {
  doctor: () => apiRequest('/doctor', doctorReportSchema),
  appSettings: () => apiRequest('/settings/app', appSettingsSchema),
  saveAppSettings: (body: AppSettingsUpdate) =>
    apiRequest('/settings/app', appSettingsSchema, { method: 'PUT', body }),
  imageBuild: () => apiRequest('/image/build', imageBuildStatusSchema),
  startImageBuild: () => apiRequest('/image/build', imageBuildStatusSchema, { method: 'POST' }),
  createTeam: () => apiRequest('/onboarding/team', onboardingTeamResponseSchema, { method: 'POST' }),
};

export const DOCTOR_TONE: Record<DoctorStatus, PillTone> = { ok: 'ok', warn: 'warn', fail: 'error' };
export const DOCTOR_LABEL: Record<DoctorStatus, string> = { ok: 'ok', warn: 'warning', fail: 'problem' };

/** IANA zones for the time zone picker; the current value is kept even if this runtime doesn't list it. */
export function timeZones(current: string): string[] {
  const all = Intl.supportedValuesOf('timeZone');
  return all.includes(current) ? all : [current, ...all];
}
