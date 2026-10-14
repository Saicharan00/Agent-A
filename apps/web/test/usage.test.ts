import { describe, expect, it } from 'vitest';
import { budgetText, formatDuration, formatTokens } from '@/lib/usage';

describe('usage wording (F28)', () => {
  it('formats run time and tokens', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(185 * 60_000)).toBe('3 h 05 min');
    expect(formatTokens(980)).toBe('980');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(4_100_000)).toBe('4.1M');
  });

  it('describes a budget and its threshold', () => {
    expect(budgetText(3, null, 'none')).toBe('3 runs, no budget');
    expect(budgetText(7, 10, 'ok')).toBe('7 of 10 runs (70 %)');
    expect(budgetText(8, 10, 'warn')).toBe('8 of 10 runs (80 %), nearly used up');
    expect(budgetText(10, 10, 'over')).toBe('10 of 10 runs (100 %), budget used up');
  });
});
