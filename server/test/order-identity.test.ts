import { afterEach, expect, it, vi } from 'vitest';
import { OutboxDatabase } from '../src/db/database.js';
import { OutboxService } from '../src/services/outbox.service.js';

afterEach(() => vi.restoreAllMocks());

it('creates distinct order and event IDs when requests share a clock and random value', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const db = new OutboxDatabase(':memory:');
  const service = new OutboxService(db, false);
  try {
    const payload = { customerId: 'cust_repeat', items: [{ name: 'Widget', quantity: 1, unitPriceEur: 5 }] };
    const first = service.createOrder(payload);
    const second = service.createOrder(payload);

    expect(first.order.id).not.toBe(second.order.id);
    expect(first.event.id).not.toBe(second.event.id);
    expect(first.event.aggregateId).toBe(first.order.id);
    expect(second.event.aggregateId).toBe(second.order.id);
    expect(db.getOrders().filter((order) => order.customerId === payload.customerId)).toHaveLength(2);
    expect(db.getOutboxEvents().filter((event) => event.aggregateId === first.order.id || event.aggregateId === second.order.id)).toHaveLength(2);
  } finally {
    db.close();
  }
});
