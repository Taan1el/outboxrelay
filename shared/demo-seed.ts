import type { ConsumerInboxItem, Order, OutboxEvent } from './types.js';
import { CONSUMER_IDS } from './outbox-logic.js';
import type { InMemorySeed } from './in-memory-outbox.js';

interface SeedRow {
  customerId: string;
  product: string;
  quantity: number;
  unitPriceEur: number;
  status: OutboxEvent['status'];
  retryCount?: number;
  /** Extra deliveries the consumer inbox rejected as duplicates. */
  duplicates?: number;
  error?: string;
  /** Milliseconds from "now" until the event may be leased again (backoff) or its lease ends. */
  dueInMs?: number;
}

const ROWS: SeedRow[] = [
  { customerId: 'cust_tallinn_katrin', product: 'Starter license', quantity: 1, unitPriceEur: 499, status: 'PUBLISHED' },
  { customerId: 'cust_tartu_jaanus', product: 'Priority support', quantity: 2, unitPriceEur: 250, status: 'PUBLISHED' },
  { customerId: 'cust_helsinki_elena', product: 'Broker node', quantity: 1, unitPriceEur: 850, status: 'PUBLISHED', duplicates: 1 },
  { customerId: 'cust_stockholm_lars', product: 'Starter license', quantity: 3, unitPriceEur: 499, status: 'PUBLISHED' },
  { customerId: 'cust_tallinn_katrin', product: 'Priority support', quantity: 1, unitPriceEur: 250, status: 'DEAD_LETTER', retryCount: 3, error: 'Broker Connection Refused (ECONNREFUSED)' },
  { customerId: 'cust_tartu_jaanus', product: 'Starter license', quantity: 1, unitPriceEur: 499, status: 'PUBLISHED' },
  { customerId: 'cust_helsinki_elena', product: 'Broker node', quantity: 2, unitPriceEur: 850, status: 'PUBLISHED', duplicates: 2 },
  { customerId: 'cust_stockholm_lars', product: 'Priority support', quantity: 1, unitPriceEur: 250, status: 'PUBLISHED' },
  { customerId: 'cust_tallinn_katrin', product: 'Broker node', quantity: 1, unitPriceEur: 850, status: 'DEAD_LETTER', retryCount: 3, error: 'Downstream Partition Jitter Timeout (ETIMEDOUT)' },
  { customerId: 'cust_tartu_jaanus', product: 'Priority support', quantity: 1, unitPriceEur: 250, status: 'PUBLISHED' },
  { customerId: 'cust_helsinki_elena', product: 'Starter license', quantity: 2, unitPriceEur: 499, status: 'PENDING', retryCount: 1, error: 'Downstream Partition Jitter Timeout (ETIMEDOUT)', dueInMs: 90_000 },
  { customerId: 'cust_stockholm_lars', product: 'Broker node', quantity: 1, unitPriceEur: 850, status: 'LEASED', dueInMs: 120_000 },
  { customerId: 'cust_tallinn_katrin', product: 'Starter license', quantity: 1, unitPriceEur: 499, status: 'PENDING' },
  { customerId: 'cust_tartu_jaanus', product: 'Priority support', quantity: 3, unitPriceEur: 250, status: 'PENDING' },
];

/** Fixed sample data for the browser demo. Only the timestamps move: they are offsets from `now`. */
export function buildDemoSeed(now: number): InMemorySeed {
  const orders: Order[] = [];
  const events: OutboxEvent[] = [];
  const inbox: InMemorySeed['inbox'] = [];
  const spacingMs = 4 * 60_000;

  ROWS.forEach((row, index) => {
    const number = 4101 + index;
    const created = now - (ROWS.length - index) * spacingMs;
    const createdAt = new Date(created).toISOString();
    const totalEur = Number((row.quantity * row.unitPriceEur).toFixed(2));
    const orderId = `ord_${number}`;
    const eventId = `evt_${number}`;
    const published = row.status === 'PUBLISHED';

    orders.push({
      id: orderId,
      customerId: row.customerId,
      itemsCount: row.quantity,
      totalEur,
      currency: 'EUR',
      status: 'CONFIRMED',
      createdAt,
      updatedAt: createdAt,
    });
    events.push({
      id: eventId,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'ORDER_CONFIRMED',
      payload: {
        orderId,
        customerId: row.customerId,
        totalEur,
        items: [{ name: row.product, quantity: row.quantity, unitPriceEur: row.unitPriceEur }],
      },
      status: row.status,
      retryCount: row.retryCount ?? 0,
      leasedUntil: row.status === 'LEASED' ? now + (row.dueInMs ?? 0) : null,
      availableAt: row.status === 'PENDING' && row.dueInMs ? now + row.dueInMs : null,
      createdAt,
      publishedAt: published ? new Date(created + 2500).toISOString() : null,
      errorMessage: row.error ?? null,
    });

    if (published) {
      CONSUMER_IDS.forEach((consumerId, consumerIndex) => {
        const duplicates = consumerIndex === 1 ? row.duplicates ?? 0 : 0;
        const item: ConsumerInboxItem & { duplicateCount: number } = {
          id: `inbox_${number}_${consumerIndex}`,
          eventId,
          consumerId,
          eventType: 'ORDER_CONFIRMED',
          processedAt: new Date(created + 2500 + consumerIndex * 40).toISOString(),
          duplicateDetected: duplicates > 0,
          duplicateCount: duplicates,
        };
        inbox.push(item);
      });
    }
  });

  return { orders, events, inbox };
}

export const DEMO_FIRST_ORDER_NUMBER = 4101 + ROWS.length;
