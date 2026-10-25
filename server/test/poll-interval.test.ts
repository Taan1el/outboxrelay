import { describe, expect, it } from 'vitest';
import { pollIntervalFromEnv } from '../src/services/outbox.service.js';

describe('background poll interval', () => {
  it.each(['100', '2500', '2147483647'])('accepts %s milliseconds', (value) => {
    expect(pollIntervalFromEnv(value)).toBe(Number(value));
  });

  it.each(['', '0', '99', '-100', '100ms', '100.5', ' 100', '1e3', '2147483648', '99999999999999999999'])
    ('uses the default for invalid value %j', (value) => {
      expect(pollIntervalFromEnv(value)).toBe(2500);
    });

  it('uses the default when unset', () => {
    expect(pollIntervalFromEnv(undefined)).toBe(2500);
  });
});
