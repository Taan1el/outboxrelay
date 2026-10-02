// In-browser stand-in for services/api.ts, used by the GitHub Pages build
// (import.meta.env.VITE_DEMO_MODE === 'true') where there is no Express server.
// It runs the same relay cycle, backoff and validation code as the server
// (shared/), on an array-backed store seeded with fixed sample data.
import type {
  BrokerFaultConfig,
  ConsumerInboxItem,
  CreateOrderPayload,
  Order,
  OutboxEvent,
  OutboxStats,
  PollCycleResult,
} from '../../../shared/types.js';
import { InMemoryOutbox } from '../../../shared/in-memory-outbox.js';
import { buildDemoSeed, DEMO_FIRST_ORDER_NUMBER } from '../../../shared/demo-seed.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_SECONDS,
  applyFaultConfig,
  buildOrderWithEvent,
  validateFaultConfig,
  validateOrderPayload,
} from '../../../shared/outbox-logic.js';
import { runRelayCycle } from '../../../shared/relay.js';

export interface DemoEngine {
  store: InMemoryOutbox;
  faults: BrokerFaultConfig;
  random: () => number;
  nextOrderNumber: number;
}

// Small seeded generator so partial-failure runs repeat the same way after a reset.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDemoEngine(clock: () => number = Date.now): DemoEngine {
  return {
    store: new InMemoryOutbox(clock, buildDemoSeed(clock())),
    faults: { mode: 'HEALTHY', failureRatePercent: 0, simulatedLatencyMs: 30 },
    random: seededRandom(2026),
    nextOrderNumber: DEMO_FIRST_ORDER_NUMBER,
  };
}

let engine = createDemoEngine();

/** Puts the sample data and broker state back to how the page first loaded. */
export function resetDemoData(): void {
  engine = createDemoEngine();
}

export async function fetchStats(): Promise<OutboxStats> {
  return { ...engine.store.getStats(), brokerMode: engine.faults.mode };
}

export async function fetchOrders(): Promise<Order[]> {
  return engine.store.getOrders();
}

export async function createOrder(payload: CreateOrderPayload): Promise<{ order: Order; event: OutboxEvent }> {
  const valid = validateOrderPayload(payload);
  const number = engine.nextOrderNumber++;
  const { order, event } = buildOrderWithEvent(valid, { orderId: `ord_${number}`, eventId: `evt_${number}` }, new Date());
  engine.store.createOrderWithOutboxEvent(order, event);
  return { order, event };
}

export async function fetchOutboxEvents(statusFilter?: string): Promise<OutboxEvent[]> {
  return engine.store.getOutboxEvents(statusFilter);
}

export async function triggerPoll(): Promise<PollCycleResult> {
  const current = engine;
  return runRelayCycle(
    current.store,
    current.faults,
    { batchSize: DEFAULT_BATCH_SIZE, leaseSeconds: DEFAULT_LEASE_SECONDS },
    {
      random: current.random,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
    },
    { batchSize: DEFAULT_BATCH_SIZE, leaseSeconds: DEFAULT_LEASE_SECONDS },
  );
}

export async function retryDeadLetter(eventId: string): Promise<void> {
  if (!engine.store.retryDeadLetterEvent(eventId)) {
    throw new Error(`Event '${eventId}' not found in DEAD_LETTER status`);
  }
}

export async function fetchConsumerInbox(): Promise<ConsumerInboxItem[]> {
  return engine.store.getConsumerInbox();
}

export async function updateBrokerFault(config: Partial<BrokerFaultConfig>): Promise<BrokerFaultConfig> {
  engine.faults = applyFaultConfig(engine.faults, validateFaultConfig(config));
  return engine.faults;
}
