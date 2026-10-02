import type { BrokerFaultConfig, OutboxEvent, PollCycleResult } from './types.js';
import { CONSUMER_IDS, failureMessage, shouldSimulateFailure, validatePollOptions } from './outbox-logic.js';

/** The storage operations one relay cycle needs; the SQLite database and the in-browser store both provide them. */
export interface RelayStore {
  leasePendingEvents(leaseSeconds: number, limit: number): OutboxEvent[];
  markEventPublished(eventId: string): void;
  markEventFailed(eventId: string, errorMessage: string): { status: 'PENDING' | 'DEAD_LETTER'; retries: number };
  recordConsumerInbox(eventId: string, consumerId: string, eventType: string): { duplicate: boolean };
}

export interface RelayEnvironment {
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * One poll cycle: lease due events, try to hand each to the simulated broker, then either
 * mark it published and record it in every consumer inbox, or schedule a retry or dead-letter it.
 */
export async function runRelayCycle(
  store: RelayStore,
  faults: BrokerFaultConfig,
  options: { batchSize?: unknown; leaseSeconds?: unknown },
  env: RelayEnvironment,
  defaults: { batchSize: number; leaseSeconds: number },
): Promise<PollCycleResult> {
  const { batchSize, leaseSeconds } = validatePollOptions(
    options.batchSize === undefined ? defaults.batchSize : options.batchSize,
    options.leaseSeconds === undefined ? defaults.leaseSeconds : options.leaseSeconds,
  );
  const started = env.now();
  const leased = store.leasePendingEvents(leaseSeconds, batchSize);

  let dispatchedCount = 0;
  let failedCount = 0;
  let deadLetterCount = 0;

  for (const event of leased) {
    if (faults.simulatedLatencyMs > 0) await env.sleep(faults.simulatedLatencyMs);

    if (shouldSimulateFailure(faults, env.random)) {
      failedCount++;
      const { status } = store.markEventFailed(event.id, failureMessage(faults.mode));
      if (status === 'DEAD_LETTER') deadLetterCount++;
    } else {
      store.markEventPublished(event.id);
      dispatchedCount++;
      for (const consumerId of CONSUMER_IDS) {
        store.recordConsumerInbox(event.id, consumerId, event.eventType);
      }
    }
  }

  return {
    leasedCount: leased.length,
    dispatchedCount,
    failedCount,
    deadLetterCount,
    durationMs: Number((env.now() - started).toFixed(2)),
  };
}
