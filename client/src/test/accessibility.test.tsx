import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App.js';
import { axe } from './axe.js';
import type { OutboxStats, Order, OutboxEvent, PollCycleResult } from '../../../shared/types.js';

const NOW = new Date('2026-03-01T10:00:00.000Z').getTime();
const iso = new Date(NOW).toISOString();

const stats: OutboxStats = {
  totalEvents: 120,
  pendingEvents: 2,
  leasedEvents: 1,
  publishedEvents: 115,
  deadLetterEvents: 2,
  totalOrders: 120,
  consumerProcessed: 345,
  consumerDuplicatesRejected: 14,
  deliverySuccessRate: 98.3,
  consumers: [
    { consumerId: 'consumer-notifications', processed: 115, duplicatesRejected: 0, lastProcessedAt: '2026-03-01T09:59:00.000Z' },
    { consumerId: 'consumer-analytics', processed: 0, duplicatesRejected: 0, lastProcessedAt: null },
  ],
  brokerMode: 'HEALTHY',
};

const orders: Order[] = [
  { id: 'ord_1', customerId: 'cust_tartu_jaanus', itemsCount: 1, totalEur: 499, currency: 'EUR', status: 'CONFIRMED', createdAt: iso, updatedAt: iso },
];

const base = {
  aggregateType: 'Order',
  eventType: 'ORDER_CONFIRMED',
  leasedUntil: null,
  availableAt: null,
  createdAt: iso,
  publishedAt: null,
  errorMessage: null,
};

const events: OutboxEvent[] = [
  { ...base, id: 'evt_pub', aggregateId: 'ord_a', payload: { totalEur: 499 }, status: 'PUBLISHED', retryCount: 0, publishedAt: iso },
  { ...base, id: 'evt_dead', aggregateId: 'ord_b', payload: { totalEur: 250 }, status: 'DEAD_LETTER', retryCount: 3, errorMessage: 'Connection refused' },
  { ...base, id: 'evt_retry', aggregateId: 'ord_c', payload: {}, status: 'PENDING', retryCount: 1, availableAt: NOW + 2000, errorMessage: 'Timeout' },
  { ...base, id: 'evt_lease', aggregateId: 'ord_d', payload: {}, status: 'LEASED', retryCount: 0, leasedUntil: NOW + 5000 },
];

const cycle: PollCycleResult = { leasedCount: 3, dispatchedCount: 2, failedCount: 1, deadLetterCount: 0, durationMs: 41.5 };

beforeEach(() => {
  global.fetch = vi.fn().mockImplementation(async (url: string) => {
    const ok = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
    if (url.endsWith('/stats')) return ok(stats);
    if (url.endsWith('/outbox/poll')) return ok(cycle);
    if (url.includes('/outbox/events?status=DEAD_LETTER')) return ok(events.filter((e) => e.status === 'DEAD_LETTER'));
    if (url.includes('/outbox/events')) return ok(events);
    if (url.endsWith('/orders')) return ok(orders);
    return ok({});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Accessibility checks', () => {
  it('has no violations in the four lanes', async () => {
    const { container } = render(<App />);
    for (const name of ['Pending', 'Leased', 'Published', 'Dead letter']) {
      const lane = (await screen.findByRole('heading', { name })).closest('section')!;
      expect(lane).toBeInTheDocument();
    }
    await screen.findAllByText('evt_retry');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the orders panel', async () => {
    const { container } = render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Place an order' })).closest('section')!;
    await within(section).findByText('ord_1');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the consumers panel', async () => {
    const { container } = render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Consumers' })).closest('section')!;
    await within(section).findByText('consumer-notifications');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations in the fault simulator after a relay cycle', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByText('98.3%');
    await user.click(screen.getByRole('radio', { name: /Full outage/ }));
    await user.click(screen.getByRole('button', { name: 'Run relay cycle' }));
    await waitFor(() => expect(screen.getByText('41.5 ms')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with a row detail open', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Show payload for evt_dead' }));
    expect(screen.getByText('Last error: Connection refused')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
