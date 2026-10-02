import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import type { ConsumerInboxItem, ConsumerStats, Order, OutboxEvent, OutboxStats } from '../../../shared/types.js';
import { CONSUMER_IDS, MAX_ATTEMPTS, deliverySuccessRate, planFailure } from '../../../shared/outbox-logic.js';
import { defaultDatabasePath } from '../lib/repoPaths.js';

export class OutboxDatabase {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const finalPath = dbPath || defaultDatabasePath();
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(finalPath);
    this.initSchema();
    this.seedSampleData();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        items_count INTEGER NOT NULL,
        total_eur REAL NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        leased_until INTEGER,
        available_at INTEGER,
        created_at TEXT NOT NULL,
        published_at TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status_leased ON outbox_events(status, leased_until);

      CREATE TABLE IF NOT EXISTS consumer_inbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        duplicate_detected INTEGER NOT NULL DEFAULT 0,
        UNIQUE(event_id, consumer_id)
      );
    `);

    // Databases created before retry backoff existed lack the available_at column.
    const columns = this.db.prepare('PRAGMA table_info(outbox_events)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'available_at')) {
      this.db.exec('ALTER TABLE outbox_events ADD COLUMN available_at INTEGER;');
    }
  }

  private seedSampleData(): void {
    const countStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM orders');
    const result = countStmt.get() as { cnt: number };
    if (result.cnt === 0) {
      const initialOrders: Array<{ order: Order; event: OutboxEvent }> = [
        {
          order: {
            id: 'ord_9801',
            customerId: 'cust_tartu_01',
            itemsCount: 2,
            totalEur: 149.5,
            currency: 'EUR',
            status: 'CONFIRMED',
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            updatedAt: new Date(Date.now() - 3600000).toISOString(),
          },
          event: {
            id: 'evt_outbox_101',
            aggregateType: 'Order',
            aggregateId: 'ord_9801',
            eventType: 'ORDER_CONFIRMED',
            payload: { customerId: 'cust_tartu_01', totalEur: 149.5, items: ['Pro-License', 'Priority-Support'] },
            status: 'PUBLISHED',
            retryCount: 0,
            leasedUntil: null,
            availableAt: null,
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            publishedAt: new Date(Date.now() - 3590000).toISOString(),
            errorMessage: null,
          }
        },
        {
          order: {
            id: 'ord_9802',
            customerId: 'cust_tallinn_42',
            itemsCount: 1,
            totalEur: 890.0,
            currency: 'EUR',
            status: 'CREATED',
            createdAt: new Date(Date.now() - 600000).toISOString(),
            updatedAt: new Date(Date.now() - 600000).toISOString(),
          },
          event: {
            id: 'evt_outbox_102',
            aggregateType: 'Order',
            aggregateId: 'ord_9802',
            eventType: 'ORDER_CREATED',
            payload: { customerId: 'cust_tallinn_42', totalEur: 890.0, warehouse: 'Tallinn-Hub-1' },
            status: 'PENDING',
            retryCount: 0,
            leasedUntil: null,
            availableAt: null,
            createdAt: new Date(Date.now() - 600000).toISOString(),
            publishedAt: null,
            errorMessage: null,
          }
        }
      ];

      for (const { order, event } of initialOrders) {
        this.createOrderWithOutboxEvent(order, event);
        if (event.status === 'PUBLISHED') {
          this.markEventPublished(event.id);
        }
      }
    }
  }

  /**
   * Atomic Dual-Write Guarantee:
   * Inserts both the Order business entity and the OutboxEvent row within a single ACID transaction.
   * If either insert fails, the transaction is rolled back completely.
   */
  public createOrderWithOutboxEvent(order: Order, event: OutboxEvent): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const orderStmt = this.db.prepare(`
        INSERT INTO orders (id, customer_id, items_count, total_eur, currency, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      orderStmt.run(
        order.id,
        order.customerId,
        order.itemsCount,
        order.totalEur,
        order.currency,
        order.status,
        order.createdAt,
        order.updatedAt
      );

      const outboxStmt = this.db.prepare(`
        INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload_json, status, retry_count, leased_until, available_at, created_at, published_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      outboxStmt.run(
        event.id,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.status,
        event.retryCount,
        event.leasedUntil,
        event.availableAt,
        event.createdAt,
        event.publishedAt,
        event.errorMessage
      );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  /**
   * Atomically leases pending or lease-expired outbox events for background dispatch.
   */
  public leasePendingEvents(leaseDurationSeconds: number = 5, limit: number = 20): OutboxEvent[] {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const selectStmt = this.db.prepare(`
        SELECT * FROM outbox_events
        WHERE (status = 'PENDING' AND (available_at IS NULL OR available_at <= ?))
           OR (status = 'LEASED' AND leased_until IS NOT NULL AND leased_until < ?)
        ORDER BY created_at ASC
        LIMIT ?
      `);
      const rows = selectStmt.all(now, now, limit) as any[];

      if (rows.length === 0) {
        this.db.exec('COMMIT;');
        return [];
      }

      const leaseExpiration = now + leaseDurationSeconds * 1000;
      const updateStmt = this.db.prepare(`
        UPDATE outbox_events
        SET status = 'LEASED', leased_until = ?
        WHERE id = ?
      `);

      const leasedEvents: OutboxEvent[] = [];
      for (const row of rows) {
        updateStmt.run(leaseExpiration, row.id);
        leasedEvents.push({
          id: row.id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: JSON.parse(row.payload_json),
          status: 'LEASED',
          retryCount: row.retry_count,
          leasedUntil: leaseExpiration,
          availableAt: row.available_at ?? null,
          createdAt: row.created_at,
          publishedAt: row.published_at,
          errorMessage: row.error_message,
        });
      }

      this.db.exec('COMMIT;');
      return leasedEvents;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public markEventPublished(eventId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE outbox_events
      SET status = 'PUBLISHED', published_at = ?, leased_until = NULL, available_at = NULL, error_message = NULL
      WHERE id = ?
    `);
    stmt.run(now, eventId);
  }

  public markEventFailed(eventId: string, errorMessage: string, maxRetries: number = MAX_ATTEMPTS): { status: 'PENDING' | 'DEAD_LETTER'; retries: number } {
    const eventRow = this.db.prepare('SELECT retry_count FROM outbox_events WHERE id = ?').get(eventId) as { retry_count: number } | undefined;
    const plan = planFailure(eventRow ? eventRow.retry_count : 0, Date.now(), maxRetries);
    this.db.prepare(`
      UPDATE outbox_events
      SET status = ?, retry_count = ?, leased_until = NULL, available_at = ?, error_message = ?
      WHERE id = ?
    `).run(plan.status, plan.retryCount, plan.availableAt, errorMessage, eventId);
    return { status: plan.status, retries: plan.retryCount };
  }

  public retryDeadLetterEvent(eventId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE outbox_events
      SET status = 'PENDING', retry_count = 0, leased_until = NULL, available_at = NULL, error_message = NULL
      WHERE id = ? AND status = 'DEAD_LETTER'
    `);
    const res = stmt.run(eventId);
    return res.changes > 0;
  }

  /**
   * Records event in consumer inbox to verify downstream idempotency.
   * If already processed by the consumer, increments duplicate_detected.
   */
  public recordConsumerInbox(eventId: string, consumerId: string, eventType: string): { duplicate: boolean } {
    const existing = this.db.prepare(
      'SELECT id, duplicate_detected FROM consumer_inbox WHERE event_id = ? AND consumer_id = ?'
    ).get(eventId, consumerId) as { id: string; duplicate_detected: number } | undefined;

    if (existing) {
      this.db.prepare(
        'UPDATE consumer_inbox SET duplicate_detected = duplicate_detected + 1 WHERE id = ?'
      ).run(existing.id);
      return { duplicate: true };
    }

    const id = `inbox_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO consumer_inbox (id, event_id, consumer_id, event_type, processed_at, duplicate_detected)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(id, eventId, consumerId, eventType, now);

    return { duplicate: false };
  }

  public getOrders(): Order[] {
    const stmt = this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50');
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      itemsCount: r.items_count,
      totalEur: r.total_eur,
      currency: r.currency,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  public getOutboxEvents(statusFilter?: string): OutboxEvent[] {
    let query = 'SELECT * FROM outbox_events';
    const params: any[] = [];
    if (statusFilter && statusFilter !== 'ALL') {
      query += ' WHERE status = ?';
      params.push(statusFilter);
    }
    query += ' ORDER BY created_at DESC LIMIT 100';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: JSON.parse(r.payload_json),
      status: r.status,
      retryCount: r.retry_count,
      leasedUntil: r.leased_until,
      availableAt: r.available_at ?? null,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      errorMessage: r.error_message,
    }));
  }

  public getConsumerInbox(): ConsumerInboxItem[] {
    const stmt = this.db.prepare('SELECT * FROM consumer_inbox ORDER BY processed_at DESC, rowid DESC LIMIT 50');
    const rows = stmt.all() as any[];
    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      consumerId: r.consumer_id,
      eventType: r.event_type,
      processedAt: r.processed_at,
      duplicateDetected: r.duplicate_detected > 0,
    }));
  }

  public getStats(): Omit<OutboxStats, 'brokerMode'> {
    const totalOrders = (this.db.prepare('SELECT COUNT(*) as cnt FROM orders').get() as any).cnt;
    const totalEvents = (this.db.prepare('SELECT COUNT(*) as cnt FROM outbox_events').get() as any).cnt;
    const pendingEvents = (this.db.prepare("SELECT COUNT(*) as cnt FROM outbox_events WHERE status = 'PENDING'").get() as any).cnt;
    const leasedEvents = (this.db.prepare("SELECT COUNT(*) as cnt FROM outbox_events WHERE status = 'LEASED'").get() as any).cnt;
    const publishedEvents = (this.db.prepare("SELECT COUNT(*) as cnt FROM outbox_events WHERE status = 'PUBLISHED'").get() as any).cnt;
    const deadLetterEvents = (this.db.prepare("SELECT COUNT(*) as cnt FROM outbox_events WHERE status = 'DEAD_LETTER'").get() as any).cnt;

    const consumerProcessed = (this.db.prepare('SELECT COUNT(*) as cnt FROM consumer_inbox').get() as any).cnt;
    const consumerDuplicates = (this.db.prepare('SELECT COALESCE(SUM(duplicate_detected), 0) as cnt FROM consumer_inbox').get() as any).cnt;

    const consumerRows = this.db.prepare(
      'SELECT consumer_id, COUNT(*) AS processed, COALESCE(SUM(duplicate_detected), 0) AS duplicates, MAX(processed_at) AS last_at FROM consumer_inbox GROUP BY consumer_id'
    ).all() as Array<{ consumer_id: string; processed: number; duplicates: number; last_at: string | null }>;
    const consumers: ConsumerStats[] = CONSUMER_IDS.map((consumerId) => {
      const row = consumerRows.find((r) => r.consumer_id === consumerId);
      return {
        consumerId,
        processed: row ? row.processed : 0,
        duplicatesRejected: row ? row.duplicates : 0,
        lastProcessedAt: row ? row.last_at : null,
      };
    });

    return {
      totalEvents,
      pendingEvents,
      leasedEvents,
      publishedEvents,
      deadLetterEvents,
      totalOrders,
      consumerProcessed,
      consumerDuplicatesRejected: consumerDuplicates,
      deliverySuccessRate: deliverySuccessRate(publishedEvents, deadLetterEvents),
      consumers,
    };
  }

  public close(): void {
    this.db.close();
  }
}