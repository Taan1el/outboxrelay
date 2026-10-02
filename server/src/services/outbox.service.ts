import { OutboxDatabase } from '../db/database.js';
import type {
  Order,
  OutboxEvent,
  CreateOrderPayload,
  BrokerFaultConfig,
  OutboxStats,
  PollCycleResult,
} from '../../../shared/types.js';

export class PollOptionsError extends Error {}

export class OutboxService {
  private db: OutboxDatabase;
  private brokerFaultConfig: BrokerFaultConfig = {
    mode: 'HEALTHY',
    failureRatePercent: 0,
    simulatedLatencyMs: 30,
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(db?: OutboxDatabase) {
    this.db = db || new OutboxDatabase();
    this.startBackgroundPoller(2500); // automatic 2.5s poller
  }

  public startBackgroundPoller(intervalMs: number = 2500): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        await this.pollAndRelay(10, 5);
      } catch {
        // background error logged silently
      } finally {
        this.isPolling = false;
      }
    }, intervalMs);
  }

  public stopBackgroundPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Atomic Dual-Write:
   * Generates order entity and corresponding outbox event, then executes atomic transaction.
   */
  public createOrder(payload: CreateOrderPayload): { order: Order; event: OutboxEvent } {
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();

    const itemsCount = payload.items.reduce((acc, item) => acc + item.quantity, 0);
    const calculatedTotal = payload.items.reduce((acc, item) => acc + item.quantity * item.unitPriceEur, 0);
    const totalEur = Number(calculatedTotal.toFixed(2));

    const order: Order = {
      id: orderId,
      customerId: payload.customerId,
      itemsCount,
      totalEur,
      currency: payload.currency || 'EUR',
      status: 'CONFIRMED',
      createdAt: now,
      updatedAt: now,
    };

    const event: OutboxEvent = {
      id: eventId,
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'ORDER_CONFIRMED',
      payload: {
        orderId,
        customerId: payload.customerId,
        totalEur,
        items: payload.items,
        timestamp: now,
      },
      status: 'PENDING',
      retryCount: 0,
      leasedUntil: null,
      createdAt: now,
      publishedAt: null,
      errorMessage: null,
    };

    this.db.createOrderWithOutboxEvent(order, event);
    return { order, event };
  }

  /**
   * Row-Leasing Poller & Dispatch Engine:
   * Leases pending outbox events, simulates message broker delivery with fault injection,
   * updates status, and delivers to downstream consumers with idempotency tracking.
   */
  public async pollAndRelay(batchSize: number = 10, leaseDurationSeconds: number = 5): Promise<PollCycleResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new PollOptionsError('batchSize must be an integer between 1 and 100');
    }
    if (!Number.isInteger(leaseDurationSeconds) || leaseDurationSeconds < 1 || leaseDurationSeconds > 300) {
      throw new PollOptionsError('leaseSeconds must be an integer between 1 and 300');
    }
    const start = performance.now();
    const leasedEvents = this.db.leasePendingEvents(leaseDurationSeconds, batchSize);

    let dispatchedCount = 0;
    let failedCount = 0;
    let deadLetterCount = 0;

    for (const event of leasedEvents) {
      if (this.brokerFaultConfig.simulatedLatencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.brokerFaultConfig.simulatedLatencyMs));
      }

      const shouldFail = this.shouldSimulateBrokerFailure();

      if (shouldFail) {
        failedCount++;
        const errorReason = this.brokerFaultConfig.mode === 'FULL_OUTAGE'
          ? 'Broker Connection Refused (ECONNREFUSED)'
          : 'Downstream Partition Jitter Timeout (ETIMEDOUT)';

        const { status } = this.db.markEventFailed(event.id, errorReason, 3);
        if (status === 'DEAD_LETTER') {
          deadLetterCount++;
        }
      } else {
        // Success: Publish to message broker and dispatch to consumers
        this.db.markEventPublished(event.id);
        dispatchedCount++;

        // Simulated downstream consumers (e.g. Email notifications, Inventory service, Analytics ledger)
        const consumers = ['consumer-notifications', 'consumer-inventory', 'consumer-analytics'];
        for (const consumerId of consumers) {
          this.db.recordConsumerInbox(event.id, consumerId, event.eventType);
        }
      }
    }

    const durationMs = Number((performance.now() - start).toFixed(2));
    return {
      leasedCount: leasedEvents.length,
      dispatchedCount,
      failedCount,
      deadLetterCount,
      durationMs,
    };
  }

  public retryDeadLetterEvent(eventId: string): boolean {
    return this.db.retryDeadLetterEvent(eventId);
  }

  public setBrokerFaultConfig(config: Partial<BrokerFaultConfig>): BrokerFaultConfig {
    if (config.mode) {
      this.brokerFaultConfig.mode = config.mode;
      if (config.mode === 'HEALTHY') {
        this.brokerFaultConfig.failureRatePercent = 0;
      } else if (config.mode === 'FULL_OUTAGE') {
        this.brokerFaultConfig.failureRatePercent = 100;
      } else if (config.mode === 'PARTIAL_FAILURES') {
        this.brokerFaultConfig.failureRatePercent = config.failureRatePercent ?? 50;
      }
    }
    if (config.simulatedLatencyMs !== undefined) {
      this.brokerFaultConfig.simulatedLatencyMs = config.simulatedLatencyMs;
    }
    return this.brokerFaultConfig;
  }

  public getOrders(): Order[] {
    return this.db.getOrders();
  }

  public getOutboxEvents(statusFilter?: string): OutboxEvent[] {
    return this.db.getOutboxEvents(statusFilter);
  }

  public getConsumerInbox(): any[] {
    return this.db.getConsumerInbox();
  }

  public getStats(): OutboxStats {
    const dbStats = this.db.getStats();
    return {
      ...dbStats,
      brokerMode: this.brokerFaultConfig.mode,
    };
  }

  private shouldSimulateBrokerFailure(): boolean {
    if (this.brokerFaultConfig.mode === 'FULL_OUTAGE') return true;
    if (this.brokerFaultConfig.mode === 'HEALTHY') return false;
    return Math.random() * 100 < this.brokerFaultConfig.failureRatePercent;
  }
}
