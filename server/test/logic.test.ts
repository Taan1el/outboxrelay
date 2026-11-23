import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEFAULT_RETRY_POLICY,
  ValidationError,
  applyFaultConfig,
  applyRetryPolicy,
  backoffDelayMs,
  buildOrderWithEvent,
  deliverySuccessRate,
  isLeasable,
  planFailure,
  retrySchedule,
  shouldSimulateFailure,
  validateFaultConfig,
  validateOrderPayload,
  validateRetryPolicy,
} from '../../shared/outbox-logic.js';
import type { BrokerFaultConfig } from '../../shared/types.js';

const healthy: BrokerFaultConfig = { mode: 'HEALTHY', failureRatePercent: 0, simulatedLatencyMs: 0 };

describe('retry backoff', () => {
  it('doubles the delay per attempt and caps it', () => {
    expect(backoffDelayMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(50)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelayMs(0)).toBe(BACKOFF_BASE_MS);
  });

  it('schedules a retry until the attempt limit, then dead-letters', () => {
    expect(planFailure(0, 1000)).toEqual({ status: 'PENDING', retryCount: 1, availableAt: 1000 + BACKOFF_BASE_MS });
    expect(planFailure(1, 1000)).toEqual({ status: 'PENDING', retryCount: 2, availableAt: 1000 + BACKOFF_BASE_MS * 2 });
    expect(planFailure(2, 1000)).toEqual({ status: 'DEAD_LETTER', retryCount: 3, availableAt: null });
    expect(planFailure(0, 1000, { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }).status).toBe('DEAD_LETTER');
  });

  it('follows a custom policy for delays, cap and attempt limit', () => {
    const policy = { maxAttempts: 5, backoffBaseMs: 500, backoffMaxMs: 1500 };
    expect(retrySchedule(policy)).toEqual([500, 1000, 1500, 1500]);
    expect(planFailure(1, 0, policy)).toEqual({ status: 'PENDING', retryCount: 2, availableAt: 1000 });
    expect(planFailure(3, 0, policy)).toEqual({ status: 'PENDING', retryCount: 4, availableAt: 1500 });
    expect(planFailure(4, 0, policy).status).toBe('DEAD_LETTER');
  });

  it('keeps the default schedule at 2 s and 4 s before the third failure dead-letters', () => {
    expect(retrySchedule(DEFAULT_RETRY_POLICY)).toEqual([2000, 4000]);
    expect(retrySchedule({ ...DEFAULT_RETRY_POLICY, maxAttempts: 1 })).toEqual([]);
  });
});

describe('retry policy validation', () => {
  it('accepts a partial patch within bounds', () => {
    expect(validateRetryPolicy({ maxAttempts: 5 })).toEqual({ maxAttempts: 5 });
    expect(validateRetryPolicy({ backoffBaseMs: 100, backoffMaxMs: 600000 })).toEqual({ backoffBaseMs: 100, backoffMaxMs: 600000 });
  });

  it.each([
    [null, 'must be a JSON object'],
    [[1], 'must be a JSON object'],
    [{}, 'needs at least one of'],
    [{ maxAttempts: 0 }, 'maxAttempts must be an integer between 1 and 10'],
    [{ maxAttempts: 11 }, 'maxAttempts must be an integer between 1 and 10'],
    [{ maxAttempts: 2.5 }, 'maxAttempts must be an integer'],
    [{ maxAttempts: '3' }, 'maxAttempts must be an integer'],
    [{ backoffBaseMs: 99 }, 'backoffBaseMs must be an integer between 100 and 60000'],
    [{ backoffMaxMs: 600001 }, 'backoffMaxMs must be an integer between 100 and 600000'],
    [{ maxAttempt: 3 }, 'Unknown retry policy field: maxAttempt'],
  ])('rejects %j', (body, message) => {
    expect(() => validateRetryPolicy(body)).toThrow(ValidationError);
    expect(() => validateRetryPolicy(body)).toThrow(message);
  });

  it('refuses a cap below the first delay after merging', () => {
    expect(() => applyRetryPolicy(DEFAULT_RETRY_POLICY, { backoffMaxMs: 1000 })).toThrow('backoffMaxMs (1000) must be at least backoffBaseMs (2000)');
    expect(applyRetryPolicy(DEFAULT_RETRY_POLICY, { backoffBaseMs: 1000, backoffMaxMs: 1000 })).toEqual({ maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 1000 });
  });

  it('does not change the shared default', () => {
    applyRetryPolicy(DEFAULT_RETRY_POLICY, { maxAttempts: 7 });
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });
});

describe('isLeasable', () => {
  it('only leases due pending rows and expired leases', () => {
    expect(isLeasable({ status: 'PENDING', availableAt: null, leasedUntil: null }, 100)).toBe(true);
    expect(isLeasable({ status: 'PENDING', availableAt: 100, leasedUntil: null }, 100)).toBe(true);
    expect(isLeasable({ status: 'PENDING', availableAt: 101, leasedUntil: null }, 100)).toBe(false);
    expect(isLeasable({ status: 'LEASED', availableAt: null, leasedUntil: 99 }, 100)).toBe(true);
    expect(isLeasable({ status: 'LEASED', availableAt: null, leasedUntil: 100 }, 100)).toBe(false);
    expect(isLeasable({ status: 'LEASED', availableAt: null, leasedUntil: null }, 100)).toBe(false);
    expect(isLeasable({ status: 'PUBLISHED', availableAt: null, leasedUntil: null }, 100)).toBe(false);
    expect(isLeasable({ status: 'DEAD_LETTER', availableAt: null, leasedUntil: null }, 100)).toBe(false);
  });
});

describe('delivery success rate', () => {
  it('is 100 with nothing completed and a one-decimal share otherwise', () => {
    expect(deliverySuccessRate(0, 0)).toBe(100);
    expect(deliverySuccessRate(2, 1)).toBe(66.7);
    expect(deliverySuccessRate(0, 4)).toBe(0);
  });
});

describe('fault simulation', () => {
  it('fails always in an outage, never when healthy, by rate otherwise', () => {
    expect(shouldSimulateFailure({ ...healthy, mode: 'FULL_OUTAGE' }, () => 0.99)).toBe(true);
    expect(shouldSimulateFailure(healthy, () => 0)).toBe(false);
    const partial: BrokerFaultConfig = { mode: 'PARTIAL_FAILURES', failureRatePercent: 50, simulatedLatencyMs: 0 };
    expect(shouldSimulateFailure(partial, () => 0.49)).toBe(true);
    expect(shouldSimulateFailure(partial, () => 0.5)).toBe(false);
  });

  it('derives the failure rate from the mode', () => {
    expect(applyFaultConfig(healthy, { mode: 'FULL_OUTAGE' }).failureRatePercent).toBe(100);
    expect(applyFaultConfig(healthy, { mode: 'PARTIAL_FAILURES' }).failureRatePercent).toBe(50);
    expect(applyFaultConfig(healthy, { mode: 'PARTIAL_FAILURES', failureRatePercent: 20 }).failureRatePercent).toBe(20);
    const outage = applyFaultConfig(healthy, { mode: 'FULL_OUTAGE', simulatedLatencyMs: 90 });
    expect(applyFaultConfig(outage, { mode: 'HEALTHY' })).toEqual({ mode: 'HEALTHY', failureRatePercent: 0, simulatedLatencyMs: 90 });
    expect(applyFaultConfig(outage, { simulatedLatencyMs: 10 }).mode).toBe('FULL_OUTAGE');
  });
});

describe('validateFaultConfig', () => {
  it.each(['HEALTHY', 'FULL_OUTAGE'] as const)('keeps %s rates fixed and defaults new partial mode to 50', (mode) => {
    const current = applyFaultConfig(healthy, { mode });
    const changed = applyFaultConfig(current, { failureRatePercent: 25, simulatedLatencyMs: 15 });
    expect(changed).toEqual({ mode, failureRatePercent: mode === 'HEALTHY' ? 0 : 100, simulatedLatencyMs: 15 });
    expect(applyFaultConfig(changed, { mode: 'PARTIAL_FAILURES' }).failureRatePercent).toBe(50);
    expect(current.simulatedLatencyMs).toBe(0);
  });

  it('accepts partial patches', () => {
    expect(validateFaultConfig({})).toEqual({});
    expect(validateFaultConfig({ mode: 'FULL_OUTAGE', simulatedLatencyMs: 0 })).toEqual({ mode: 'FULL_OUTAGE', simulatedLatencyMs: 0 });
  });

  it.each([
    [null], [[]], ['x'], [{ mode: 'BROKEN' }], [{ mode: 3 }], [{ failureRatePercent: 101 }], [{ failureRatePercent: -1 }],
    [{ failureRatePercent: '5' }], [{ simulatedLatencyMs: -5 }], [{ simulatedLatencyMs: 5001 }], [{ simulatedLatencyMs: NaN }],
  ])('rejects %j', (body) => {
    expect(() => validateFaultConfig(body)).toThrow();
  });
});

describe('validateOrderPayload', () => {
  const valid = { customerId: ' cust_1 ', items: [{ name: 'Pack', quantity: 2, unitPriceEur: 9.99 }] };

  it('trims the customer id and keeps only known item fields', () => {
    const result = validateOrderPayload({ ...valid, items: [{ ...valid.items[0], extra: 1 }] });
    expect(result.customerId).toBe('cust_1');
    expect(result.items).toEqual(valid.items);
  });

  it.each([
    [null], [[]], [{}], [{ customerId: '', items: valid.items }], [{ customerId: 'c', items: [] }], [{ customerId: 'c', items: 'x' }],
    [{ customerId: 5, items: valid.items }], [{ customerId: 'c', items: [null] }],
    [{ customerId: 'c', items: [{ name: '', quantity: 1, unitPriceEur: 1 }] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: 0, unitPriceEur: 1 }] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: 1.5, unitPriceEur: 1 }] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: '1', unitPriceEur: 1 }] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: 1, unitPriceEur: -1 }] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: 1, unitPriceEur: Infinity }] }],
    [{ customerId: 'c', items: valid.items, currency: 'euro' }],
  ])('rejects %j', (body) => {
    expect(() => validateOrderPayload(body)).toThrow();
  });
});

describe('buildOrderWithEvent', () => {
  it('totals the items and links the event to the order', () => {
    const { order, event } = buildOrderWithEvent(
      { customerId: 'c', items: [{ name: 'a', quantity: 3, unitPriceEur: 0.1 }, { name: 'b', quantity: 1, unitPriceEur: 0.2 }] },
      { orderId: 'ord_1', eventId: 'evt_1' },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(order).toMatchObject({ id: 'ord_1', itemsCount: 4, totalEur: 0.5, currency: 'EUR', status: 'CONFIRMED' });
    expect(event).toMatchObject({ id: 'evt_1', aggregateId: 'ord_1', status: 'PENDING', retryCount: 0, availableAt: null });
    expect(event.payload.totalEur).toBe(0.5);
  });
});
