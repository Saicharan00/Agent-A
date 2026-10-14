import { describe, expect, it } from 'vitest';
import { cronToPreset, describeCron, presetToCron } from '@/lib/schedules';

describe('schedule presets (F26)', () => {
  it('builds cron from presets', () => {
    expect(presetToCron({ kind: 'weekdays', time: '08:45', day: 1 })).toBe('45 8 * * 1-5');
    expect(presetToCron({ kind: 'daily', time: '07:05', day: 1 })).toBe('5 7 * * *');
    expect(presetToCron({ kind: 'weekly', time: '16:45', day: 5 })).toBe('45 16 * * 5');
    expect(presetToCron({ kind: 'hourly', time: '00:15', day: 1 })).toBe('15 * * * *');
    expect(presetToCron({ kind: 'custom', time: '09:00', day: 1, cron: '*/10 9-17 * * *' })).toBe(
      '*/10 9-17 * * *',
    );
  });

  it('round-trips presets and falls back to custom', () => {
    for (const cron of ['45 8 * * 1-5', '5 7 * * *', '45 16 * * 5', '15 * * * *'])
      expect(presetToCron(cronToPreset(cron))).toBe(cron);
    expect(cronToPreset('*/10 9-17 * * *')).toMatchObject({ kind: 'custom', cron: '*/10 9-17 * * *' });
    expect(cronToPreset('0 9 1 * *').kind).toBe('custom');
  });

  it('describes cron for people', () => {
    expect(describeCron('45 8 * * 1-5')).toBe('Weekdays at 08:45');
    expect(describeCron('45 16 * * 5')).toBe('Fridays at 16:45');
    expect(describeCron('5 7 * * *')).toBe('Every day at 07:05');
    expect(describeCron('15 * * * *')).toBe('Every hour at :15');
    expect(describeCron('0 9 1 * *')).toBe('cron 0 9 1 * *');
  });
});
