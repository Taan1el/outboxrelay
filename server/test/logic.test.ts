import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  applyFaultConfig,
  backoffDelayMs,
  buildOrderWithEvent,
  deliverySuccessRate,
  isLeasable,
  planFailure,
  shouldSimulateFailure,
  validateFaultConfig,
  validateOrderPayload,
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
    expect(planFailure(0, 1000, 1).status).toBe('DEAD_LETTER');
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
