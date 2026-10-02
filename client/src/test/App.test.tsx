import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App.js';
import type { OutboxStats, Order, OutboxEvent, PollCycleResult } from '../../../shared/types.js';

const NOW = new Date('2026-03-01T10:00:00.000Z').getTime();

const mockStats: OutboxStats = {
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
    { consumerId: 'consumer-inventory', processed: 115, duplicatesRejected: 14, lastProcessedAt: '2026-03-01T09:59:01.000Z' },
    { consumerId: 'consumer-analytics', processed: 0, duplicatesRejected: 0, lastProcessedAt: null },
  ],
  brokerMode: 'HEALTHY',
};

const mockOrders: Order[] = [
  {
    id: 'ord_mock_1',
    customerId: 'cust_tartu_jaanus',
    itemsCount: 1,
    totalEur: 499,
    currency: 'EUR',
    status: 'CONFIRMED',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  },
];

const base = {
  aggregateType: 'Order',
  eventType: 'ORDER_CONFIRMED',
  leasedUntil: null,
  availableAt: null,
  createdAt: new Date(NOW).toISOString(),
  publishedAt: null,
  errorMessage: null,
};

const mockEvents: OutboxEvent[] = [
  { ...base, id: 'evt_pub', aggregateId: 'ord_a', payload: { totalEur: 499 }, status: 'PUBLISHED', retryCount: 0, publishedAt: new Date(NOW).toISOString() },
  { ...base, id: 'evt_dead', aggregateId: 'ord_b', payload: { totalEur: 250 }, status: 'DEAD_LETTER', retryCount: 3, errorMessage: 'Connection refused' },
  { ...base, id: 'evt_retry', aggregateId: 'ord_c', payload: {}, status: 'PENDING', retryCount: 1, availableAt: NOW + 2000, errorMessage: 'Timeout' },
];

const cycle: PollCycleResult = { leasedCount: 3, dispatchedCount: 2, failedCount: 1, deadLetterCount: 0, durationMs: 41.5 };

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let failStats = false;
let failPoll = false;

function installFetch() {
  calls = [];
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
    if (url.endsWith('/stats')) {
      return failStats ? { ok: false, statusText: 'Server Error', json: async () => ({ error: 'database is locked' }) } : ok(mockStats);
    }
    if (url.endsWith('/outbox/poll')) {
      return failPoll ? { ok: false, statusText: 'Bad Request', json: async () => ({ error: 'batchSize must be an integer' }) } : ok(cycle);
    }
    if (url.includes('/outbox/events?status=DEAD_LETTER')) return ok(mockEvents.filter((e) => e.status === 'DEAD_LETTER'));
    if (url.includes('/retry')) return { ok: true, json: async () => ({ success: true }) };
    if (url.includes('/outbox/events')) return ok(mockEvents);
    if (url.endsWith('/orders') && method === 'POST') {
      return ok({ order: { ...mockOrders[0], id: 'ord_new', totalEur: 998 }, event: { ...mockEvents[2], id: 'evt_new', status: 'PENDING' } });
    }
    if (url.endsWith('/orders')) return ok(mockOrders);
    return ok({});
  });
}

const calledWith = (method: string, fragment: string) => calls.filter((c) => c.method === method && c.url.includes(fragment));

describe('OutboxRelay operations console', () => {
  beforeEach(() => {
    failStats = false;
    failPoll = false;
    installFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the product name, broker state and the tally', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'OutboxRelay' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('98.3%')).toBeInTheDocument());
    expect(screen.getByText('115 published, 2 dead-lettered')).toBeInTheDocument();
    expect(screen.getByText('120 outbox rows')).toBeInTheDocument();
    expect(screen.getByText('345 deliveries')).toBeInTheDocument();
    expect(screen.getByText(/Broker healthy/)).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Delivery success' })).toHaveAttribute('aria-valuenow', '98.3');
  });

  it('sorts outbox rows into four lanes with counts and the next retry time', async () => {
    render(<App />);
    const pending = (await screen.findByRole('heading', { name: 'Pending' })).closest('section')!;
    expect(within(pending).getByText('1')).toBeInTheDocument();
    expect(within(pending).getByText('evt_retry')).toBeInTheDocument();
    expect(within(pending).getByText(/^retry at \d\d:\d\d:\d\d$/)).toBeInTheDocument();
    expect(within(pending).getByText(/^1 of 3 attempts, created/)).toBeInTheDocument();
    const published = screen.getByRole('heading', { name: 'Published' }).closest('section')!;
    expect(within(published).getByText('evt_pub')).toBeInTheDocument();
    const leased = screen.getByRole('heading', { name: 'Leased' }).closest('section')!;
    expect(within(leased).getByText('Nothing is leased.')).toBeInTheDocument();
    expect(within(leased).getByLabelText('0 rows')).toBeInTheDocument();
    expect(within(pending).getByLabelText('1 row')).toBeInTheDocument();
  });

  it('expands a row to show its payload and last error', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Show payload for evt_dead' });
    await user.click(screen.getByRole('button', { name: 'Show payload for evt_dead' }));
    expect(screen.getByText('Last error: Connection refused')).toBeInTheDocument();
    expect(screen.getByText(/"totalEur": 250/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide payload for evt_dead' }));
    expect(screen.queryByText(/"totalEur": 250/)).not.toBeInTheDocument();
  });

  it('shows consumers, including one with no deliveries', async () => {
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Consumers' })).closest('section')!;
    expect(within(section).getByText('consumer-inventory')).toBeInTheDocument();
    expect(within(section).getByText(/^14 duplicates rejected, last delivery [0-9]{2}:[0-9]{2}:[0-9]{2}$/)).toBeInTheDocument();
    expect(within(section).getByText('0 duplicates rejected, no deliveries yet')).toBeInTheDocument();
    expect(within(section).getAllByText("115 events")).toHaveLength(2);
  });

  it('replays a dead-lettered event through the retry endpoint', async () => {
    const user = userEvent.setup();
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Dead letter' })).closest('section')!;
    expect(await within(section).findByText('Connection refused')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: /Replay/ }));
    await waitFor(() => expect(calledWith('POST', '/outbox/events/evt_dead/retry')).toHaveLength(1));
  });

  it('runs a relay cycle and prints its result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('98.3%');
    await user.click(screen.getByRole('button', { name: 'Run relay cycle' }));
    const results = (await screen.findByRole('heading', { name: 'Last relay cycle' })).parentElement!;
    await waitFor(() => expect(within(results).getByText('41.5 ms')).toBeInTheDocument());
    expect(calledWith('POST', '/outbox/poll')[0].body).toEqual({ batchSize: 10, leaseSeconds: 5 });
    expect(within(results).getByText('Dead-lettered')).toBeInTheDocument();
  });

  it('reports a failed relay cycle with the server message', async () => {
    failPoll = true;
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('98.3%');
    await user.click(screen.getByRole('button', { name: 'Run relay cycle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Relay cycle failed: batchSize must be an integer');
    expect(screen.getByRole('button', { name: 'Run relay cycle' })).toBeEnabled();
  });

  it('saves an order with the chosen product and quantity', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('98.3%');
    await user.selectOptions(screen.getByLabelText('Product'), 'node');
    const quantity = screen.getByLabelText('Quantity');
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Save order and event' }));
    await waitFor(() => expect(calledWith('POST', '/orders')).toHaveLength(1));
    expect(calledWith('POST', '/orders')[0].body).toEqual({
      customerId: 'cust_tallinn_katrin',
      items: [{ name: 'Broker node', quantity: 2, unitPriceEur: 850 }],
      currency: 'EUR',
    });
    expect(await screen.findByText(/Saved ord_new \(EUR 998\.00\) with outbox row evt_new/)).toBeInTheDocument();
  });

  it('applies broker settings', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('98.3%');
    await user.click(screen.getByRole('radio', { name: /Full outage/ }));
    await user.click(screen.getByRole('button', { name: 'Apply broker settings' }));
    await waitFor(() => expect(calledWith('POST', '/broker/fault-config')).toHaveLength(1));
    expect(calledWith('POST', '/broker/fault-config')[0].body).toEqual({ mode: 'FULL_OUTAGE', simulatedLatencyMs: 30 });
    expect(await screen.findByText('Broker set to full outage.')).toBeInTheDocument();
  });

  it('lists events waiting for a retry in the fault simulator', async () => {
    render(<App />);
    const heading = await screen.findByRole('heading', { name: 'Waiting for retry' });
    const results = heading.parentElement!;
    expect(await within(results).findByText('evt_retry')).toBeInTheDocument();
    expect(within(results).getByText(/A failed delivery is retried after 2 s, 4 s/)).toBeInTheDocument();
  });

  it('shows a load error and recovers on retry', async () => {
    failStats = true;
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('database is locked');
    failStats = false;
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('98.3%')).toBeInTheDocument();
  });

  it('refreshes on a timer and stops after unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = calledWith('GET', '/stats').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calledWith('GET', '/stats').length).toBe(initial + 2);
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calledWith('GET', '/stats').length).toBe(initial + 2);
  });

  it('uses no emoji in the visible text', async () => {
    render(<App />);
    await screen.findByText('98.3%');
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
