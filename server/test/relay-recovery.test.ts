import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxDatabase } from '../src/db/database.js';
import { InMemoryOutbox } from '../../shared/in-memory-outbox.js';
import { buildOrderWithEvent, CONSUMER_IDS } from '../../shared/outbox-logic.js';
import { runRelayCycle } from '../../shared/relay.js';

describe.each(['sqlite', 'memory'] as const)('%s relay receipt recovery', (kind) => {
  let db: OutboxDatabase | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    db?.close();
    db = undefined;
  });

  it.each([0, 1, 2, 3])('recovers after failure at write %i', async (failureAt) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-10-17T06:00:00Z');
    vi.setSystemTime(now);
    const store = kind === 'sqlite' ? (db = new OutboxDatabase(':memory:')) : new InMemoryOutbox();
    // Keep seeded events outside this cycle and its recovery window.
    store.leasePendingEvents(300, 100);
    const { order, event } = buildOrderWithEvent(
      { customerId: 'recovery', items: [{ name: 'Parcel', quantity: 1, unitPriceEur: 10 }] },
      { orderId: 'order_recovery', eventId: 'event_recovery' }, new Date(now),
    );
    store.createOrderWithOutboxEvent(order, event);
    const record = store.recordConsumerInbox.bind(store);
    let writes = 0;
    const receiptSpy = vi.spyOn(store, 'recordConsumerInbox').mockImplementation((...args) => {
      if (writes++ === failureAt) throw new Error('Receipt storage unavailable');
      return record(...args);
    });
    const publishSpy = vi.spyOn(store, 'markEventPublished');
    if (failureAt === 3) publishSpy.mockImplementationOnce(() => { throw new Error('Publication storage unavailable'); });
    const cycle = () => runRelayCycle(store,
      { mode: 'HEALTHY', failureRatePercent: 0, simulatedLatencyMs: 0 }, {},
      { now: Date.now, random: () => 0, sleep: async () => {} },
      { batchSize: 1, leaseSeconds: 5 });

    await expect(cycle()).rejects.toThrow('storage unavailable');
    expect(store.getOutboxEvents().find((row) => row.id === event.id)).toMatchObject({
      status: 'LEASED', retryCount: 0, publishedAt: null,
    });
    expect(store.getConsumerInbox().filter((row) => row.eventId === event.id)).toHaveLength(failureAt);
    if (failureAt < 3) expect(publishSpy).not.toHaveBeenCalled();
    receiptSpy.mockRestore();
    publishSpy.mockRestore();
    await expect(cycle()).resolves.toMatchObject({ leasedCount: 0 });

    vi.setSystemTime(now + 5001);
    await expect(cycle()).resolves.toMatchObject({ leasedCount: 1, dispatchedCount: 1, failedCount: 0 });
    const receipts = store.getConsumerInbox().filter((row) => row.eventId === event.id);
    expect(receipts.map((row) => row.consumerId).sort()).toEqual([...CONSUMER_IDS].sort());
    expect(receipts.filter((row) => row.duplicateDetected)).toHaveLength(failureAt);
    expect(store.getOutboxEvents().find((row) => row.id === event.id)?.status).toBe('PUBLISHED');
    await expect(cycle()).resolves.toMatchObject({ leasedCount: 0 });
  });
});
