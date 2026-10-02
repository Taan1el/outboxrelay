import type {
  OutboxStats,
  OutboxEvent,
  Order,
  CreateOrderPayload,
  ConsumerInboxItem,
  BrokerFaultConfig,
  PollCycleResult,
} from '../../../shared/types.js';

// BASE_URL is '/' normally; the API always lives at the site root, so only the demo build
// (which never calls fetch) runs under a sub-path.
const API_BASE = `${import.meta.env.BASE_URL}api`;

async function request<T>(path: string, init: RequestInit | undefined, label: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body && typeof body.error === 'string' ? body.error : `${label}: ${res.statusText || res.status}`);
  }
  const json = await res.json();
  return json.data;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchStats = (): Promise<OutboxStats> => request('/stats', undefined, 'Failed to fetch stats');

export const fetchOrders = (): Promise<Order[]> => request('/orders', undefined, 'Failed to fetch orders');

export const createOrder = (payload: CreateOrderPayload): Promise<{ order: Order; event: OutboxEvent }> =>
  request('/orders', jsonPost(payload), 'Failed to create order');

export function fetchOutboxEvents(statusFilter?: string): Promise<OutboxEvent[]> {
  const query = statusFilter && statusFilter !== 'ALL' ? `?status=${encodeURIComponent(statusFilter)}` : '';
  return request(`/outbox/events${query}`, undefined, 'Failed to fetch outbox events');
}

export const triggerPoll = (): Promise<PollCycleResult> =>
  request('/outbox/poll', jsonPost({ batchSize: 10, leaseSeconds: 5 }), 'Failed to trigger poll');

export async function retryDeadLetter(eventId: string): Promise<void> {
  await request(`/outbox/events/${encodeURIComponent(eventId)}/retry`, { method: 'POST' }, 'Failed to retry event');
}

export const fetchConsumerInbox = (): Promise<ConsumerInboxItem[]> =>
  request('/consumer/inbox', undefined, 'Failed to fetch consumer inbox');

export const updateBrokerFault = (config: Partial<BrokerFaultConfig>): Promise<BrokerFaultConfig> =>
  request('/broker/fault-config', jsonPost(config), 'Failed to update broker fault');
