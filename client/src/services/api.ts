import type {
  OutboxStats,
  OutboxEvent,
  Order,
  CreateOrderPayload,
  ConsumerInboxItem,
  BrokerFaultConfig,
  PollCycleResult,
} from '../../../shared/types.js';

const API_BASE = '/api';

export async function fetchStats(): Promise<OutboxStats> {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.statusText}`);
  const json = await res.json();
  return json.data;
}

export async function fetchOrders(): Promise<Order[]> {
  const res = await fetch(`${API_BASE}/orders`);
  if (!res.ok) throw new Error(`Failed to fetch orders: ${res.statusText}`);
  const json = await res.json();
  return json.data;
}

export async function createOrder(payload: CreateOrderPayload): Promise<{ order: Order; event: OutboxEvent }> {
  const res = await fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data;
}

export async function fetchOutboxEvents(statusFilter?: string): Promise<OutboxEvent[]> {
  const url = statusFilter && statusFilter !== 'ALL'
    ? `${API_BASE}/outbox/events?status=${statusFilter}`
    : `${API_BASE}/outbox/events`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch outbox events: ${res.statusText}`);
  const json = await res.json();
  return json.data;
}

export async function triggerPoll(): Promise<PollCycleResult> {
  const res = await fetch(`${API_BASE}/outbox/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchSize: 10, leaseSeconds: 5 }),
  });
  if (!res.ok) throw new Error(`Failed to trigger poll: ${res.statusText}`);
  const json = await res.json();
  return json.data;
}

export async function retryDeadLetter(eventId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/outbox/events/${encodeURIComponent(eventId)}/retry`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to retry event: ${res.statusText}`);
}

export async function fetchConsumerInbox(): Promise<ConsumerInboxItem[]> {
  const res = await fetch(`${API_BASE}/consumer/inbox`);
  if (!res.ok) throw new Error(`Failed to fetch consumer inbox: ${res.statusText}`);
  const json = await res.json();
  return json.data;
}

export async function updateBrokerFault(config: Partial<BrokerFaultConfig>): Promise<BrokerFaultConfig> {
  const res = await fetch(`${API_BASE}/broker/fault-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`Failed to update broker fault: ${res.statusText}`);
  const json = await res.json();
  return json.data;
}