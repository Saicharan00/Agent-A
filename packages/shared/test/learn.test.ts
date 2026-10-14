import { describe, expect, it } from 'vitest';
import { scheduleReview } from '../src/learn';

const now = new Date('2026-10-14T00:00:00.000Z');
const days = (iso: string) => (Date.parse(iso) - now.getTime()) / 86_400_000;

describe('scheduleReview', () => {
  it('steps 1d, 3d, 7d, 21d on "got it" and then stays at 21d', () => {
    let count = 0;
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = scheduleReview(count, 'got_it', now);
      steps.push(days(next.nextReviewAt));
      count = next.reviewedCount;
    }
    expect(steps).toEqual([1, 3, 7, 21, 21]);
    expect(count).toBe(5);
  });

  it('"review again" starts over at 1 day', () => {
    expect(scheduleReview(3, 'again', now)).toEqual({
      reviewedCount: 0,
      nextReviewAt: '2026-10-15T00:00:00.000Z',
    });
  });
});
