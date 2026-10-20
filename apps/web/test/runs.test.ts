import { RUN_STATUSES, RUN_TRIGGERS } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { RUN_TRIGGER_LABELS, runStatusView } from '@/lib/runs';

describe('run labels', () => {
  it('labels every status, flagging failures and limits', () => {
    for (const s of RUN_STATUSES) expect(runStatusView(s).label).not.toBe('');
    expect(runStatusView('failed').tone).toBe('error');
    expect(runStatusView('limited').tone).toBe('warn');
    expect(runStatusView('cancelled').label).toBe('Stopped');
  });

  it('labels every trigger', () => {
    for (const t of RUN_TRIGGERS) expect(RUN_TRIGGER_LABELS[t]).toBeTruthy();
  });
});
