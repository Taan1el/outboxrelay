export type OutboxEventStatus = 'PENDING' | 'LEASED' | 'PUBLISHED' | 'DEAD_LETTER';

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: OutboxEventStatus;
  retryCount: number;
  leasedUntil: number | null;
  /** Earliest time (epoch ms) a retried event may be leased again; null when no backoff applies. */
  availableAt: number | null;
  createdAt: string;
  publishedAt: string | null;
  errorMessage: string | null;
}

export interface Order {
  id: string;
  customerId: string;
  itemsCount: number;
  totalEur: number;
  currency: string;
  status: 'CREATED' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED';
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderPayload {
  customerId: string;
  items: Array<{ name: string; quantity: number; unitPriceEur: number }>;
  currency?: string;
}

export interface ConsumerInboxItem {
  id: string;
  eventId: string;
  consumerId: string;
  eventType: string;
  processedAt: string;
  duplicateDetected: boolean;
}

export interface BrokerFaultConfig {
  mode: 'HEALTHY' | 'PARTIAL_FAILURES' | 'FULL_OUTAGE';
  failureRatePercent: number;
  simulatedLatencyMs: number;
}

export interface ConsumerStats {
  consumerId: string;
  processed: number;
  duplicatesRejected: number;
  lastProcessedAt: string | null;
}

export interface OutboxStats {
  totalEvents: number;
  pendingEvents: number;
  leasedEvents: number;
  publishedEvents: number;
  deadLetterEvents: number;
  totalOrders: number;
  consumerProcessed: number;
  consumerDuplicatesRejected: number;
  deliverySuccessRate: number;
  consumers: ConsumerStats[];
  brokerMode: 'HEALTHY' | 'PARTIAL_FAILURES' | 'FULL_OUTAGE';
}

export interface PollCycleResult {
  leasedCount: number;
  dispatchedCount: number;
  failedCount: number;
  deadLetterCount: number;
  durationMs: number;
}
