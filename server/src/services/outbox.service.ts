import { OutboxDatabase } from '../db/database.js';
import { randomUUID } from 'node:crypto';
import type {
  Order,
  OutboxEvent,
  CreateOrderPayload,
  BrokerFaultConfig,
  ConsumerInboxItem,
  OutboxStats,
  PollCycleResult,
  RetryBatchResult,
} from '../../../shared/types.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_SECONDS,
  PollOptionsError,
  applyFaultConfig,
  buildOrderWithEvent,
} from '../../../shared/outbox-logic.js';
import { runRelayCycle } from '../../../shared/relay.js';

export { PollOptionsError };

export class OutboxService {
  private db: OutboxDatabase;
  private brokerFaultConfig: BrokerFaultConfig = {
    mode: 'HEALTHY',
    failureRatePercent: 0,
    simulatedLatencyMs: 30,
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(db?: OutboxDatabase, autoStart: boolean = true) {
    this.db = db || new OutboxDatabase();
    if (autoStart) this.startBackgroundPoller(pollIntervalFromEnv(process.env.POLL_INTERVAL_MS));
  }

  public startBackgroundPoller(intervalMs: number = 2500): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        await this.pollAndRelay();
      } catch {
        // A failed background cycle is retried on the next tick.
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
   * Writes the order row and its outbox event in one SQLite transaction, so either both
   * exist or neither does.
   */
  public createOrder(payload: CreateOrderPayload): { order: Order; event: OutboxEvent } {
    const stamp = randomUUID();
    const result = buildOrderWithEvent(payload, { orderId: `ord_${stamp}`, eventId: `evt_${stamp}` }, new Date());
    this.db.createOrderWithOutboxEvent(result.order, result.event);
    return result;
  }

  /**
   * One relay cycle: lease due events (pending, or leased with an expired lease), hand them to
   * the simulated broker and record the outcome. Delivery is at-least-once: an event whose
   * lease expires before it is marked published can be delivered again.
   */
  public async pollAndRelay(
    batchSize?: unknown,
    leaseDurationSeconds?: unknown,
  ): Promise<PollCycleResult> {
    return runRelayCycle(
      this.db,
      this.brokerFaultConfig,
      { batchSize, leaseSeconds: leaseDurationSeconds },
      {
        random: Math.random,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => performance.now(),
      },
      { batchSize: DEFAULT_BATCH_SIZE, leaseSeconds: DEFAULT_LEASE_SECONDS },
    );
  }

  public retryDeadLetterEvent(eventId: string): boolean {
    return this.db.retryDeadLetterEvent(eventId);
  }

  public retryDeadLetterEvents(eventIds: string[]): RetryBatchResult {
    return this.db.retryDeadLetterEvents(eventIds);
  }

  public setBrokerFaultConfig(config: Partial<BrokerFaultConfig>): BrokerFaultConfig {
    this.brokerFaultConfig = applyFaultConfig(this.brokerFaultConfig, config);
    return this.brokerFaultConfig;
  }

  public getOrders(): Order[] {
    return this.db.getOrders();
  }

  public getOutboxEvents(statusFilter?: string): OutboxEvent[] {
    return this.db.getOutboxEvents(statusFilter);
  }

  public getConsumerInbox(): ConsumerInboxItem[] {
    return this.db.getConsumerInbox();
  }

  public getStats(): OutboxStats {
    return { ...this.db.getStats(), brokerMode: this.brokerFaultConfig.mode };
  }
}

export function pollIntervalFromEnv(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return 2500;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 2_147_483_647 ? parsed : 2500;
}
