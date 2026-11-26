import type {
  BrokerFaultConfig,
  CreateOrderPayload,
  Order,
  OutboxEvent,
  RetryPolicy,
} from './types.js';

/** Default number of failed attempts after which an event moves to the dead-letter queue. */
export const MAX_ATTEMPTS = 3;
/** Default delay before the first retry; each further failure doubles it. */
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 60_000;

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: MAX_ATTEMPTS,
  backoffBaseMs: BACKOFF_BASE_MS,
  backoffMaxMs: BACKOFF_MAX_MS,
});

/** Bounds a retry policy must stay within. */
export const RETRY_POLICY_LIMITS = {
  maxAttempts: { min: 1, max: 10 },
  backoffBaseMs: { min: 100, max: 60_000 },
  backoffMaxMs: { min: 100, max: 600_000 },
} as const;

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_LEASE_SECONDS = 5;
export const MAX_BATCH_SIZE = 100;
export const MAX_LEASE_SECONDS = 300;
export const MAX_LATENCY_MS = 5000;

export const CONSUMER_IDS = ['consumer-notifications', 'consumer-inventory', 'consumer-analytics'] as const;

/** Most event ids one batch replay request may carry. */
export const MAX_RETRY_BATCH = 500;
export const MAX_EVENT_ID_LENGTH = 100;

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

/**
 * Delay before retry number `attempt` (1 for the first retry). With the default policy:
 * 2s, 4s, 8s, capped at 60s.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** exponent);
}

/** The waits between attempts under a policy: one entry per retry before the event is dead-lettered. */
export function retrySchedule(policy: RetryPolicy): number[] {
  return Array.from({ length: policy.maxAttempts - 1 }, (_, i) => backoffDelayMs(i + 1, policy));
}

export interface FailurePlan {
  status: 'PENDING' | 'DEAD_LETTER';
  retryCount: number;
  availableAt: number | null;
}

/** Decides what happens to an event after a failed delivery attempt. */
export function planFailure(previousRetryCount: number, now: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): FailurePlan {
  const retryCount = previousRetryCount + 1;
  if (retryCount >= policy.maxAttempts) {
    return { status: 'DEAD_LETTER', retryCount, availableAt: null };
  }
  return { status: 'PENDING', retryCount, availableAt: now + backoffDelayMs(retryCount, policy) };
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
  next.mode = patch.mode ?? current.mode;
  if (next.mode === 'HEALTHY') next.failureRatePercent = 0;
  else if (next.mode === 'FULL_OUTAGE') next.failureRatePercent = 100;
  else next.failureRatePercent = patch.failureRatePercent
    ?? (current.mode === 'PARTIAL_FAILURES' ? current.failureRatePercent : 50);
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

/**
 * Reads a retry policy patch. Every field is optional, but at least one must be present;
 * unknown fields are rejected so a typo cannot silently leave the policy unchanged.
 */
export function validateRetryPolicy(body: unknown): Partial<RetryPolicy> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Retry policy must be a JSON object');
  }
  const fields = Object.keys(RETRY_POLICY_LIMITS) as Array<keyof RetryPolicy>;
  const unknown = Object.keys(body).filter((key) => !(fields as string[]).includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown retry policy field: ${unknown[0]}`);
  }
  const patch: Partial<RetryPolicy> = {};
  for (const field of fields) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const { min, max } = RETRY_POLICY_LIMITS[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new ValidationError(`${field} must be an integer between ${min} and ${max}`);
    }
    patch[field] = value;
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError(`Retry policy needs at least one of ${fields.join(', ')}`);
  }
  return patch;
}

/** Applies a validated patch; the resulting cap may not be lower than the first delay. */
export function applyRetryPolicy(current: RetryPolicy, patch: Partial<RetryPolicy>): RetryPolicy {
  const next: RetryPolicy = { ...current, ...patch };
  if (next.backoffMaxMs < next.backoffBaseMs) {
    throw new ValidationError(`backoffMaxMs (${next.backoffMaxMs}) must be at least backoffBaseMs (${next.backoffBaseMs})`);
  }
  return next;
}

/** Environment variables that set the retry policy a server starts with. */
export const RETRY_POLICY_ENV = {
  maxAttempts: 'RETRY_MAX_ATTEMPTS',
  backoffBaseMs: 'RETRY_BACKOFF_BASE_MS',
  backoffMaxMs: 'RETRY_BACKOFF_MAX_MS',
} as const satisfies Record<keyof RetryPolicy, string>;

/**
 * The starting retry policy from the environment. Unset or empty variables keep the built-in
 * default. A value that is not an integer within the API limits throws, naming the variable,
 * so a typo stops the server instead of quietly running with a different policy.
 */
export function retryPolicyFromEnv(env: Record<string, string | undefined>): RetryPolicy {
  const patch: Partial<RetryPolicy> = {};
  for (const field of Object.keys(RETRY_POLICY_ENV) as Array<keyof RetryPolicy>) {
    const name = RETRY_POLICY_ENV[field];
    const raw = env[name]?.trim();
    if (!raw) continue;
    const { min, max } = RETRY_POLICY_LIMITS[field];
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ValidationError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
    }
    patch[field] = value;
  }
  try {
    return applyRetryPolicy(DEFAULT_RETRY_POLICY, patch);
  } catch {
    const next = { ...DEFAULT_RETRY_POLICY, ...patch };
    throw new ValidationError(
      `${RETRY_POLICY_ENV.backoffMaxMs} (${next.backoffMaxMs}) must be at least ${RETRY_POLICY_ENV.backoffBaseMs} (${next.backoffBaseMs})`,
    );
  }
}

/**
 * Reads a retry policy saved earlier. Returns null when the stored value is not a complete,
 * valid policy (for example after the limits changed), so the caller falls back to its default.
 */
export function parseStoredRetryPolicy(json: string): RetryPolicy | null {
  try {
    const value: unknown = JSON.parse(json);
    const patch = validateRetryPolicy(value);
    if (Object.keys(patch).length !== Object.keys(RETRY_POLICY_LIMITS).length) return null;
    return applyRetryPolicy(DEFAULT_RETRY_POLICY, patch);
  } catch {
    return null;
  }
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

/**
 * Reads a batch replay request, `{ "ids": [...] }`. Duplicate ids are collapsed and the
 * first-seen order is kept, so the result lists every id once.
 */
export function validateRetryBatch(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Replay request must be a JSON object');
  }
  const { ids } = body as Record<string, unknown>;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('ids must be a non-empty array of event ids');
  }
  if (ids.length > MAX_RETRY_BATCH) {
    throw new ValidationError(`ids may hold at most ${MAX_RETRY_BATCH} event ids per request`);
  }
  const unique = new Set<string>();
  ids.forEach((id, index) => {
    if (typeof id !== 'string' || id.trim() === '' || id.length > MAX_EVENT_ID_LENGTH) {
      throw new ValidationError(`ids[${index}] must be a non-empty string of at most ${MAX_EVENT_ID_LENGTH} characters`);
    }
    unique.add(id);
  });
  return [...unique];
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
