import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxDatabase } from '../src/db/database.js';
import { InMemoryOutbox } from '../../shared/in-memory-outbox.js';
import { buildOrderWithEvent } from '../../shared/outbox-logic.js';
import { runRelayCycle } from '../../shared/relay.js';

describe.each(['sqlite', 'memory'] as const)('%s lease ownership', (kind) => {
  let db: OutboxDatabase | undefined;
  afterEach(() => { db?.close(); db = undefined; vi.useRealTimers(); });

  it('prevents an expired worker from publishing or failing a reclaimed event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-10-26T06:00:00Z');
    vi.setSystemTime(start);
    const store = kind === 'sqlite' ? (db = new OutboxDatabase(':memory:')) : new InMemoryOutbox();
    store.leasePendingEvents(300, 100);
    const { order, event } = buildOrderWithEvent(
      { customerId: 'lease', items: [{ name: 'Parcel', quantity: 1, unitPriceEur: 10 }] },
      { orderId: 'order_lease', eventId: 'event_lease' }, new Date(start),
    );
    store.createOrderWithOutboxEvent(order, event);
    const first = store.leasePendingEvents(1, 1)[0];
    vi.setSystemTime(start + 1001);
    const second = store.leasePendingEvents(5, 1)[0];
    expect(second.leasedUntil).not.toBe(first.leasedUntil);
    expect(store.ownsLease(event.id, first.leasedUntil!)).toBe(false);
    expect(store.ownsLease(event.id, second.leasedUntil!)).toBe(true);
    store.markEventPublished(event.id, first.leasedUntil!);
    store.markEventFailed(event.id, 'late failure', undefined, first.leasedUntil!);
    expect(store.getOutboxEvents().find((row) => row.id === event.id)).toMatchObject({
      status: 'LEASED', leasedUntil: second.leasedUntil, retryCount: 0,
    });
    store.markEventPublished(event.id, second.leasedUntil!);
    expect(store.getOutboxEvents().find((row) => row.id === event.id)?.status).toBe('PUBLISHED');
  });

  it('skips receipts when a cycle loses its lease during broker latency', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-10-26T06:00:00Z');
    vi.setSystemTime(start);
    const store = kind === 'sqlite' ? (db = new OutboxDatabase(':memory:')) : new InMemoryOutbox();
    store.leasePendingEvents(300, 100);
    const { order, event } = buildOrderWithEvent(
      { customerId: 'lease', items: [{ name: 'Parcel', quantity: 1, unitPriceEur: 10 }] },
      { orderId: 'order_latency', eventId: 'event_latency' }, new Date(start),
    );
    store.createOrderWithOutboxEvent(order, event);
    const result = await runRelayCycle(store, { mode: 'HEALTHY', failureRatePercent: 0, simulatedLatencyMs: 1 },
      { batchSize: 1, leaseSeconds: 1 },
      { now: Date.now, random: () => 0, sleep: async () => {
        vi.setSystemTime(start + 1001);
        store.leasePendingEvents(5, 1);
      } }, { batchSize: 1, leaseSeconds: 1 });
    expect(result).toMatchObject({ leasedCount: 1, dispatchedCount: 0, failedCount: 0 });
    expect(store.getConsumerInbox().filter((row) => row.eventId === event.id)).toHaveLength(0);
    expect(store.getOutboxEvents().find((row) => row.id === event.id)?.status).toBe('LEASED');
  });
});
