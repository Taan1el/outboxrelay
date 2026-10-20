import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxDatabase } from '../src/db/database.js';
import { InMemoryOutbox } from '../../shared/in-memory-outbox.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(['sqlite', 'memory'] as const)('%s receipt identity', (kind) => {
  it('stores distinct deliveries when clock and random values repeat', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T06:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const store = kind === 'sqlite' ? new OutboxDatabase(':memory:') : new InMemoryOutbox();
    try {
      for (const eventId of ['event-a', 'event-b']) {
        for (const consumerId of ['consumer-inventory', 'consumer-analytics']) {
          expect(store.recordConsumerInbox(eventId, consumerId, 'ORDER_CONFIRMED')).toEqual({ duplicate: false });
        }
      }
      const receipts = store.getConsumerInbox().filter((row) => row.eventId.startsWith('event-'));
      expect(receipts).toHaveLength(4);
      expect(new Set(receipts.map((row) => row.id)).size).toBe(4);
      const original = receipts.find((row) => row.eventId === 'event-a' && row.consumerId === 'consumer-inventory')!;
      expect(store.recordConsumerInbox('event-a', 'consumer-inventory', 'ORDER_CONFIRMED')).toEqual({ duplicate: true });
      expect(store.getConsumerInbox().find((row) => row.id === original.id)).toEqual({
        ...original, duplicateDetected: true,
      });
    } finally {
      if (store instanceof OutboxDatabase) store.close();
    }
  });
});

it('preserves seeded receipt IDs and allocates distinct IDs after restoring a store', () => {
  const seed = {
    orders: [], events: [],
    inbox: ['inbox_1', 'inbox_3', 'custom-receipt'].map((id) => ({
      id, eventId: `event-${id}`, consumerId: 'consumer-inventory', eventType: 'ORDER_CONFIRMED',
      processedAt: '2026-10-20T06:00:00.000Z', duplicateDetected: false,
    })),
  };
  const first = new InMemoryOutbox(() => 0, seed);
  first.recordConsumerInbox('new-a', 'consumer-inventory', 'ORDER_CONFIRMED');
  first.recordConsumerInbox('new-b', 'consumer-inventory', 'ORDER_CONFIRMED');
  const restored = new InMemoryOutbox(() => 0, { ...seed, inbox: first.getConsumerInbox() });
  restored.recordConsumerInbox('new-c', 'consumer-inventory', 'ORDER_CONFIRMED');
  const receipts = restored.getConsumerInbox();
  expect(receipts).toHaveLength(6);
  expect(new Set(receipts.map((row) => row.id)).size).toBe(6);
  for (const row of seed.inbox) expect(receipts).toContainEqual(row);
  expect(restored.recordConsumerInbox('new-a', 'consumer-inventory', 'ORDER_CONFIRMED')).toEqual({ duplicate: true });
  expect(restored.getConsumerInbox()).toHaveLength(6);
});
