import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OutboxDatabase } from '../src/db/database.js';
import { InMemoryOutbox } from '../../shared/in-memory-outbox.js';
import { BACKOFF_BASE_MS, buildOrderWithEvent } from '../../shared/outbox-logic.js';

const T0 = new Date('2026-03-01T10:00:00.000Z').getTime();

function addOrder(store: OutboxDatabase | InMemoryOutbox, n: number, at: number) {
  const { order, event } = buildOrderWithEvent(
    { customerId: `cust_${n}`, items: [{ name: 'Item', quantity: 1, unitPriceEur: 10 }] },
    { orderId: `ord_${n}`, eventId: `evt_${n}` },
    new Date(at),
  );
  store.createOrderWithOutboxEvent(order, event);
}

describe('retry backoff in SQLite', () => {
  let db: OutboxDatabase;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    db = new OutboxDatabase(':memory:');
    db.leasePendingEvents(5, 100); // take the sample event out of the way
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('holds a failed event back until its backoff elapses', () => {
    addOrder(db, 1, T0);
    expect(db.leasePendingEvents(5, 10).map((e) => e.id)).toEqual(['evt_1']);
    expect(db.markEventFailed('evt_1', 'boom').status).toBe('PENDING');
    const stored = db.getOutboxEvents().find((e) => e.id === 'evt_1')!;
    expect(stored).toMatchObject({ status: 'PENDING', retryCount: 1, availableAt: T0 + BACKOFF_BASE_MS, errorMessage: 'boom' });

    vi.setSystemTime(T0 + BACKOFF_BASE_MS - 1);
    expect(db.leasePendingEvents(5, 10)).toHaveLength(0);
    vi.setSystemTime(T0 + BACKOFF_BASE_MS);
    expect(db.leasePendingEvents(5, 10).map((e) => e.id)).toEqual(['evt_1']);
  });

  it('reclaims an event whose lease expired without an outcome', () => {
    addOrder(db, 2, T0);
    expect(db.leasePendingEvents(5, 10).map((e) => e.id)).toEqual(['evt_2']);
    vi.setSystemTime(T0 + 5000);
    expect(db.leasePendingEvents(5, 10)).toHaveLength(0);
    vi.setSystemTime(T0 + 5001);
    expect(db.leasePendingEvents(5, 10).map((e) => e.id)).toContain('evt_2');
  });

  it('clears backoff when an event is replayed from the dead-letter queue', () => {
    addOrder(db, 3, T0);
    for (let i = 0; i < 3; i++) db.markEventFailed('evt_3', 'boom');
    expect(db.getOutboxEvents('DEAD_LETTER').map((e) => e.id)).toContain('evt_3');
    expect(db.retryDeadLetterEvent('evt_3')).toBe(true);
    expect(db.retryDeadLetterEvent('evt_3')).toBe(false);
    expect(db.getOutboxEvents().find((e) => e.id === 'evt_3')).toMatchObject({
      status: 'PENDING',
      retryCount: 0,
      availableAt: null,
      errorMessage: null,
    });
  });

  it('migrates a database created before the available_at column existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outboxrelay-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE outbox_events (id TEXT PRIMARY KEY, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
      leased_until INTEGER, created_at TEXT NOT NULL, published_at TEXT, error_message TEXT);`);
    old.close();
    const migrated = new OutboxDatabase(file);
    expect(migrated.getOutboxEvents().length).toBeGreaterThan(0);
    expect(migrated.getOutboxEvents()[0].availableAt).toBeNull();
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('consumer inbox and stats', () => {
  let db: OutboxDatabase;
  beforeEach(() => {
    db = new OutboxDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('returns camelCase rows and counts duplicates per consumer', () => {
    db.recordConsumerInbox('evt_a', 'consumer-inventory', 'ORDER_CONFIRMED');
    db.recordConsumerInbox('evt_a', 'consumer-inventory', 'ORDER_CONFIRMED');
    db.recordConsumerInbox('evt_a', 'consumer-analytics', 'ORDER_CONFIRMED');
    const inbox = db.getConsumerInbox();
    expect(inbox).toHaveLength(2);
    expect(inbox.find((i) => i.consumerId === 'consumer-inventory')).toMatchObject({ eventId: 'evt_a', duplicateDetected: true });
    expect(inbox.find((i) => i.consumerId === 'consumer-analytics')?.duplicateDetected).toBe(false);

    const stats = db.getStats();
    expect(stats.consumerProcessed).toBe(2);
    expect(stats.consumerDuplicatesRejected).toBe(1);
    expect(stats.consumers.map((c) => [c.consumerId, c.processed, c.duplicatesRejected])).toEqual([
      ['consumer-notifications', 0, 0],
      ['consumer-inventory', 1, 1],
      ['consumer-analytics', 1, 0],
    ]);
    expect(stats.consumers[0].lastProcessedAt).toBeNull();
    expect(stats.consumers[1].lastProcessedAt).not.toBeNull();
  });
});

describe('in-memory store parity with SQLite', () => {
  afterEach(() => vi.useRealTimers());

  it('ends in the same state for the same operations', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const db = new OutboxDatabase(':memory:');
    const mem = new InMemoryOutbox(Date.now, {
      orders: db.getOrders(),
      events: db.getOutboxEvents(),
      inbox: db.getConsumerInbox(),
    });
    const both = [db, mem];

    for (const s of both) {
      s.leasePendingEvents(5, 100);
      addOrder(s, 10, T0 + 1000);
      addOrder(s, 11, T0 + 2000);
      s.leasePendingEvents(5, 10);
      s.markEventPublished('evt_10');
      s.recordConsumerInbox('evt_10', 'consumer-inventory', 'ORDER_CONFIRMED');
      s.recordConsumerInbox('evt_10', 'consumer-inventory', 'ORDER_CONFIRMED');
      s.markEventFailed('evt_11', 'down');
    }
    vi.setSystemTime(T0 + 20_000);
    for (const s of both) {
      s.leasePendingEvents(5, 10);
      s.markEventFailed('evt_11', 'down');
      s.markEventFailed('evt_11', 'down');
    }

    const strip = <T extends { id: string }>(rows: T[]) => rows.map(({ id: _id, ...rest }) => rest);
    expect(mem.getOutboxEvents()).toEqual(db.getOutboxEvents());
    expect(mem.getOrders()).toEqual(db.getOrders());
    expect(strip(mem.getConsumerInbox())).toEqual(strip(db.getConsumerInbox()));
    expect(mem.getStats()).toEqual(db.getStats());
    expect(mem.getOutboxEvents('DEAD_LETTER').map((e) => e.id)).toEqual(['evt_11']);
    db.close();
  });
});
