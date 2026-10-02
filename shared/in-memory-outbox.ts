import type {
  ConsumerInboxItem,
  ConsumerStats,
  Order,
  OutboxEvent,
  OutboxStats,
} from './types.js';
import { CONSUMER_IDS, MAX_ATTEMPTS, deliverySuccessRate, isLeasable, planFailure } from './outbox-logic.js';
import type { RelayStore } from './relay.js';

export interface InMemorySeed {
  orders: Order[];
  events: OutboxEvent[];
  inbox: Array<ConsumerInboxItem & { duplicateCount?: number }>;
}

/**
 * Array-backed store with the same lifecycle rules as the SQLite database (leasing, backoff,
 * dead-lettering, inbox deduplication). The browser demo runs on it; a server test checks that
 * both stores end up in the same state for the same sequence of operations.
 */
export class InMemoryOutbox implements RelayStore {
  private orders: Order[] = [];
  private events: OutboxEvent[] = [];
  private inbox: Array<ConsumerInboxItem & { duplicateCount: number }> = [];
  private inboxSequence = 0;

  constructor(private clock: () => number = Date.now, seed?: InMemorySeed) {
    if (seed) {
      this.orders = seed.orders.map((o) => ({ ...o }));
      this.events = seed.events.map((e) => ({ ...e, payload: { ...e.payload } }));
      this.inbox = seed.inbox.map((i) => ({ ...i, duplicateCount: i.duplicateCount ?? (i.duplicateDetected ? 1 : 0) }));
    }
  }

  createOrderWithOutboxEvent(order: Order, event: OutboxEvent): void {
    if (this.orders.some((o) => o.id === order.id) || this.events.some((e) => e.id === event.id)) {
      throw new Error('UNIQUE constraint failed: duplicate id');
    }
    this.orders.push({ ...order });
    this.events.push({ ...event, payload: { ...event.payload } });
  }

  leasePendingEvents(leaseSeconds: number = 5, limit: number = 20): OutboxEvent[] {
    const now = this.clock();
    const due = this.events
      .filter((e) => isLeasable(e, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    const leaseExpiration = now + leaseSeconds * 1000;
    for (const event of due) {
      event.status = 'LEASED';
      event.leasedUntil = leaseExpiration;
    }
    return due.map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  markEventPublished(eventId: string): void {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) return;
    event.status = 'PUBLISHED';
    event.publishedAt = new Date(this.clock()).toISOString();
    event.leasedUntil = null;
    event.availableAt = null;
    event.errorMessage = null;
  }

  markEventFailed(eventId: string, errorMessage: string, maxRetries: number = MAX_ATTEMPTS): { status: 'PENDING' | 'DEAD_LETTER'; retries: number } {
    const event = this.events.find((e) => e.id === eventId);
    const plan = planFailure(event ? event.retryCount : 0, this.clock(), maxRetries);
    if (event) {
      event.status = plan.status;
      event.retryCount = plan.retryCount;
      event.leasedUntil = null;
      event.availableAt = plan.availableAt;
      event.errorMessage = errorMessage;
    }
    return { status: plan.status, retries: plan.retryCount };
  }

  retryDeadLetterEvent(eventId: string): boolean {
    const event = this.events.find((e) => e.id === eventId && e.status === 'DEAD_LETTER');
    if (!event) return false;
    event.status = 'PENDING';
    event.retryCount = 0;
    event.leasedUntil = null;
    event.availableAt = null;
    event.errorMessage = null;
    return true;
  }

  recordConsumerInbox(eventId: string, consumerId: string, eventType: string): { duplicate: boolean } {
    const existing = this.inbox.find((i) => i.eventId === eventId && i.consumerId === consumerId);
    if (existing) {
      existing.duplicateCount += 1;
      existing.duplicateDetected = true;
      return { duplicate: true };
    }
    this.inboxSequence += 1;
    this.inbox.push({
      id: `inbox_${this.inboxSequence}`,
      eventId,
      consumerId,
      eventType,
      processedAt: new Date(this.clock()).toISOString(),
      duplicateDetected: false,
      duplicateCount: 0,
    });
    return { duplicate: false };
  }

  getOrders(): Order[] {
    return [...this.orders].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map((o) => ({ ...o }));
  }

  getOutboxEvents(statusFilter?: string): OutboxEvent[] {
    return [...this.events]
      .reverse()
      .filter((e) => !statusFilter || statusFilter === 'ALL' || e.status === statusFilter)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  getConsumerInbox(): ConsumerInboxItem[] {
    return [...this.inbox]
      .reverse() // newest insert first on equal timestamps, like the SQLite rowid tiebreak
      .sort((a, b) => b.processedAt.localeCompare(a.processedAt))
      .slice(0, 50)
      .map(({ duplicateCount: _count, ...item }) => ({ ...item }));
  }

  getStats(): Omit<OutboxStats, 'brokerMode'> {
    const count = (status: string) => this.events.filter((e) => e.status === status).length;
    const published = count('PUBLISHED');
    const deadLetter = count('DEAD_LETTER');
    const consumers: ConsumerStats[] = CONSUMER_IDS.map((consumerId) => {
      const rows = this.inbox.filter((i) => i.consumerId === consumerId);
      const latest = rows.reduce<string | null>((max, r) => (max === null || r.processedAt > max ? r.processedAt : max), null);
      return {
        consumerId,
        processed: rows.length,
        duplicatesRejected: rows.reduce((sum, r) => sum + r.duplicateCount, 0),
        lastProcessedAt: latest,
      };
    });
    return {
      totalEvents: this.events.length,
      pendingEvents: count('PENDING'),
      leasedEvents: count('LEASED'),
      publishedEvents: published,
      deadLetterEvents: deadLetter,
      totalOrders: this.orders.length,
      consumerProcessed: this.inbox.length,
      consumerDuplicatesRejected: this.inbox.reduce((sum, i) => sum + i.duplicateCount, 0),
      deliverySuccessRate: deliverySuccessRate(published, deadLetter),
      consumers,
    };
  }
}
