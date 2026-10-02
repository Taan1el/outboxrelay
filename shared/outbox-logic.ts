import type {
  BrokerFaultConfig,
  CreateOrderPayload,
  Order,
  OutboxEvent,
} from './types.js';

/** Failed attempts after which an event moves to the dead-letter queue. */
export const MAX_ATTEMPTS = 3;
/** Delay before the first retry; each further failure doubles it. */
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 60_000;

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_LEASE_SECONDS = 5;
export const MAX_BATCH_SIZE = 100;
export const MAX_LEASE_SECONDS = 300;
export const MAX_LATENCY_MS = 5000;

export const CONSUMER_IDS = ['consumer-notifications', 'consumer-inventory', 'consumer-analytics'] as const;

export const BROKER_MODES = ['HEALTHY', 'PARTIAL_FAILURES', 'FULL_OUTAGE'] as const;

export class PollOptionsError extends Error {}
export class ValidationError extends Error {}

export function validatePollOptions(batchSize: unknown, leaseSeconds: unknown): { batchSize: number; leaseSeconds: number } {
  if (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new PollOptionsError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  if (typeof leaseSeconds !== 'number' || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_LEASE_SECONDS) {
    throw new PollOptionsError(`leaseSeconds must be an integer between 1 and ${MAX_LEASE_SECONDS}`);
  }
  return { batchSize, leaseSeconds };
}

/** Delay before retry number `attempt` (1 for the first retry): 2s, 4s, 8s, capped at 60s. */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

export interface FailurePlan {
  status: 'PENDING' | 'DEAD_LETTER';
  retryCount: number;
  availableAt: number | null;
}

/** Decides what happens to an event after a failed delivery attempt. */
export function planFailure(previousRetryCount: number, now: number, maxAttempts: number = MAX_ATTEMPTS): FailurePlan {
  const retryCount = previousRetryCount + 1;
  if (retryCount >= maxAttempts) {
    return { status: 'DEAD_LETTER', retryCount, availableAt: null };
  }
  return { status: 'PENDING', retryCount, availableAt: now + backoffDelayMs(retryCount) };
}

/** True when a poller may lease the event: pending and due, or leased with an expired lease. */
export function isLeasable(event: Pick<OutboxEvent, 'status' | 'availableAt' | 'leasedUntil'>, now: number): boolean {
  if (event.status === 'PENDING') return event.availableAt === null || event.availableAt <= now;
  if (event.status === 'LEASED') return event.leasedUntil !== null && event.leasedUntil < now;
  return false;
}

export function deliverySuccessRate(published: number, deadLetter: number): number {
  const completed = published + deadLetter;
  return completed > 0 ? Number(((published / completed) * 100).toFixed(1)) : 100;
}

export function failureMessage(mode: BrokerFaultConfig['mode']): string {
  return mode === 'FULL_OUTAGE'
    ? 'Broker Connection Refused (ECONNREFUSED)'
    : 'Downstream Partition Jitter Timeout (ETIMEDOUT)';
}

/** `random` returns a number in [0, 1). */
export function shouldSimulateFailure(config: BrokerFaultConfig, random: () => number): boolean {
  if (config.mode === 'FULL_OUTAGE') return true;
  if (config.mode === 'HEALTHY') return false;
  return random() * 100 < config.failureRatePercent;
}

/** Applies a validated fault-config patch and returns the new configuration. */
export function applyFaultConfig(current: BrokerFaultConfig, patch: Partial<BrokerFaultConfig>): BrokerFaultConfig {
  const next = { ...current };
  if (patch.mode) {
    next.mode = patch.mode;
    if (patch.mode === 'HEALTHY') next.failureRatePercent = 0;
    else if (patch.mode === 'FULL_OUTAGE') next.failureRatePercent = 100;
    else next.failureRatePercent = patch.failureRatePercent ?? 50;
  }
  if (patch.simulatedLatencyMs !== undefined) next.simulatedLatencyMs = patch.simulatedLatencyMs;
  return next;
}

export function validateFaultConfig(body: unknown): Partial<BrokerFaultConfig> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Fault configuration must be a JSON object');
  }
  const { mode, failureRatePercent, simulatedLatencyMs } = body as Record<string, unknown>;
  const patch: Partial<BrokerFaultConfig> = {};
  if (mode !== undefined) {
    if (typeof mode !== 'string' || !(BROKER_MODES as readonly string[]).includes(mode)) {
      throw new ValidationError(`mode must be one of ${BROKER_MODES.join(', ')}`);
    }
    patch.mode = mode as BrokerFaultConfig['mode'];
  }
  if (failureRatePercent !== undefined) {
    if (typeof failureRatePercent !== 'number' || !Number.isFinite(failureRatePercent) || failureRatePercent < 0 || failureRatePercent > 100) {
      throw new ValidationError('failureRatePercent must be a number between 0 and 100');
    }
    patch.failureRatePercent = failureRatePercent;
  }
  if (simulatedLatencyMs !== undefined) {
    if (typeof simulatedLatencyMs !== 'number' || !Number.isFinite(simulatedLatencyMs) || simulatedLatencyMs < 0 || simulatedLatencyMs > MAX_LATENCY_MS) {
      throw new ValidationError(`simulatedLatencyMs must be a number between 0 and ${MAX_LATENCY_MS}`);
    }
    patch.simulatedLatencyMs = simulatedLatencyMs;
  }
  return patch;
}

export function validateOrderPayload(body: unknown): CreateOrderPayload {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Order must be a JSON object');
  }
  const { customerId, items, currency } = body as Record<string, unknown>;
  if (typeof customerId !== 'string' || customerId.trim() === '' || !Array.isArray(items) || items.length === 0) {
    throw new ValidationError('customerId and non-empty items array are required');
  }
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    throw new ValidationError('currency must be a three-letter uppercase code');
  }
  const cleaned = items.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    if (typeof row.name !== 'string' || row.name.trim() === '') {
      throw new ValidationError(`items[${index}].name is required`);
    }
    if (typeof row.quantity !== 'number' || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000) {
      throw new ValidationError(`items[${index}].quantity must be an integer between 1 and 1000`);
    }
    if (typeof row.unitPriceEur !== 'number' || !Number.isFinite(row.unitPriceEur) || row.unitPriceEur < 0 || row.unitPriceEur > 1_000_000) {
      throw new ValidationError(`items[${index}].unitPriceEur must be a number between 0 and 1000000`);
    }
    return { name: row.name, quantity: row.quantity, unitPriceEur: row.unitPriceEur };
  });
  return { customerId: customerId.trim(), items: cleaned, currency: currency as string | undefined };
}

/** Builds the order row and the matching outbox event that are written together. */
export function buildOrderWithEvent(
  payload: CreateOrderPayload,
  ids: { orderId: string; eventId: string },
  now: Date,
): { order: Order; event: OutboxEvent } {
  const iso = now.toISOString();
  const itemsCount = payload.items.reduce((sum, item) => sum + item.quantity, 0);
  const totalEur = Number(payload.items.reduce((sum, item) => sum + item.quantity * item.unitPriceEur, 0).toFixed(2));
  const order: Order = {
    id: ids.orderId,
    customerId: payload.customerId,
    itemsCount,
    totalEur,
    currency: payload.currency || 'EUR',
    status: 'CONFIRMED',
    createdAt: iso,
    updatedAt: iso,
  };
  const event: OutboxEvent = {
    id: ids.eventId,
    aggregateType: 'Order',
    aggregateId: ids.orderId,
    eventType: 'ORDER_CONFIRMED',
    payload: { orderId: ids.orderId, customerId: payload.customerId, totalEur, items: payload.items, timestamp: iso },
    status: 'PENDING',
    retryCount: 0,
    leasedUntil: null,
    availableAt: null,
    createdAt: iso,
    publishedAt: null,
    errorMessage: null,
  };
  return { order, event };
}
