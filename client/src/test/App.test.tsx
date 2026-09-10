import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../App.js';
import type { OutboxStats, Order, OutboxEvent, ConsumerInboxItem } from '../../../shared/types.js';

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const mockEvents: OutboxEvent[] = [
  {
    id: 'evt_mock_1',
    aggregateType: 'Order',
    aggregateId: 'ord_mock_1',
    eventType: 'ORDER_CONFIRMED',
    payload: { totalEur: 499 },
    status: 'PUBLISHED',
    retryCount: 0,
    leasedUntil: null,
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    errorMessage: null,
  },
  {
    id: 'evt_mock_2',
    aggregateType: 'Order',
    aggregateId: 'ord_mock_2',
    eventType: 'ORDER_CONFIRMED',
    payload: { totalEur: 250 },
    status: 'DEAD_LETTER',
    retryCount: 3,
    leasedUntil: null,
    createdAt: new Date().toISOString(),
    publishedAt: null,
    errorMessage: 'Connection refused',
  },
];

const mockInbox: ConsumerInboxItem[] = [
  {
    id: 'inbox_1',
    eventId: 'evt_mock_1',
    consumerId: 'consumer-notifications',
    eventType: 'ORDER_CONFIRMED',
    processedAt: new Date().toISOString(),
    duplicateDetected: false,
  },
];

describe('OutboxRelay Operations Console', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/stats')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: mockStats }),
        });
      }
      if (url.includes('/orders')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: mockOrders }),
        });
      }
      if (url.includes('/outbox/events')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: mockEvents }),
        });
      }
      if (url.includes('/consumer/inbox')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: mockInbox }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });
    });
  });

  it('renders branding, stats bar, and broker mode badge', async () => {
    render(<App />);

    expect(screen.getAllByText('OutboxRelay').length).toBeGreaterThanOrEqual(1);

    await waitFor(() => {
      expect(screen.getByText('98.3%')).toBeInTheDocument();
      expect(screen.getByText('115 published / 2 dead-lettered')).toBeInTheDocument();
    });

    expect(screen.getAllByText(/Broker: HEALTHY/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders checkout simulator with atomic dual-write trigger', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Dual-Write Atomicity Simulator/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Commit Order & Outbox Event/i)).toBeInTheDocument();
  });

  it('renders outbox events stream with dead-letter replay button', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('evt_mock_1')).toBeInTheDocument();
      expect(screen.getByText('evt_mock_2')).toBeInTheDocument();
    });

    expect(screen.getByText(/🔁 Replay DLQ/i)).toBeInTheDocument();
  });

  it('renders broker chaos options and consumer nodes', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Message Broker Chaos Controls/i)).toBeInTheDocument();
      expect(screen.getByText(/PARTIAL JITTER/i)).toBeInTheDocument();
      expect(screen.getByText(/FULL OUTAGE/i)).toBeInTheDocument();
    });

    expect(screen.getByText('consumer-notifications')).toBeInTheDocument();
  });
});