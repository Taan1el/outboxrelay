import { describe, it, expect } from 'vitest';
import { formatClock, formatEur } from '../utils/format.js';

describe('format helpers', () => {
  it('pads the clock to HH:MM:SS', () => {
    const d = new Date(2026, 2, 1, 4, 5, 9);
    expect(formatClock(d.getTime())).toBe('04:05:09');
    expect(formatClock(d.toISOString())).toBe('04:05:09');
  });

  it('prints euro amounts with two decimals', () => {
    expect(formatEur(499)).toBe('EUR 499.00');
    expect(formatEur(0.5)).toBe('EUR 0.50');
  });
});
