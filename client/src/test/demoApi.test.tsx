import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as demo from '../services/demoApi.js';

const T0 = new Date('2026-03-01T10:00:00.000Z').getTime();
const order = { customerId: 'cust_demo', items: [{ name: 'Starter license', quantity: 2, unitPriceEur: 499 }] };

describe('browser demo API', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(T0);
    demo.resetDemoData();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts from fixed sample data covering every status', async () => {
    const stats = await demo.fetchStats();
    expect(stats).toMatchObject({
      totalEvents: 14,
      totalOrders: 14,
      publishedEvents: 8,
      deadLetterEvents: 2,
      pendingEvents: 3,
      leasedEvents: 1,
      brokerMode: 'HEALTHY',
      consumerDuplicatesRejected: 3,
      deliverySuccessRate: 80,
    });
    expect(stats.consumers.map((c) => c.processed)).toEqual([8, 8, 8]);
    const first = await demo.fetchOutboxEvents('ALL');
    const again = (demo.resetDemoData(), await demo.fetchOutboxEvents('ALL'));
    expect(again).toEqual(first);
  });

  it('saves an order with its outbox row and numbers them in sequence', async () => {
    const a = await demo.createOrder(order);
    vi.setSystemTime(T0 + 1000);
    const b = await demo.createOrder(order);
    expect(a.order).toMatchObject({ id: 'ord_4115', totalEur: 998, itemsCount: 2 });
    expect(a.event).toMatchObject({ id: 'evt_4115', status: 'PENDING', aggregateId: 'ord_4115' });
    expect(b.order.id).toBe('ord_4116');
    expect((await demo.fetchOrders())[0].id).toBe('ord_4116');
    expect((await demo.fetchStats()).totalOrders).toBe(16);
  });

  it('rejects an invalid order without storing it', async () => {
    await expect(demo.createOrder({ customerId: 'c', items: [] })).rejects.toThrow(/non-empty items/);
    await expect(demo.createOrder({ customerId: 'c', items: [{ name: 'x', quantity: 0, unitPriceEur: 1 }] })).rejects.toThrow(/quantity/);
    expect((await demo.fetchStats()).totalOrders).toBe(14);
  });

  it('relays due events and leaves backed-off ones alone', async () => {
    const poll = demo.triggerPoll();
    await vi.advanceTimersByTimeAsync(500);
    const result = await poll;
    // Two plain pending rows are due; the retrying row waits for its backoff and the lease is still held.
    expect(result).toMatchObject({ leasedCount: 2, dispatchedCount: 2, failedCount: 0 });
    const stats = await demo.fetchStats();
    expect(stats.publishedEvents).toBe(10);
    expect(stats.pendingEvents).toBe(1);
    expect(stats.consumers.map((c) => c.processed)).toEqual([10, 10, 10]);
  });

  it('retries after backoff and dead-letters on the third failure, then replays', async () => {
    await demo.updateBrokerFault({ mode: 'FULL_OUTAGE', simulatedLatencyMs: 0 });
    const run = async () => {
      const p = demo.triggerPoll();
      await vi.advanceTimersByTimeAsync(0);
      return p;
    };
    await run(); // the two fresh rows fail once
    vi.setSystemTime(T0 + 3000);
    await run(); // second failure
    vi.setSystemTime(T0 + 3000 + 5000);
    const third = await run();
    expect(third.deadLetterCount).toBeGreaterThanOrEqual(2);
    const dead = await demo.fetchOutboxEvents('DEAD_LETTER');
    expect(dead.length).toBeGreaterThanOrEqual(4);
    expect(dead.every((e) => e.retryCount === 3)).toBe(true);

    await demo.retryDeadLetter(dead[0].id);
    expect((await demo.fetchOutboxEvents('PENDING')).map((e) => e.id)).toContain(dead[0].id);
    await expect(demo.retryDeadLetter(dead[0].id)).rejects.toThrow(/not found/);
  });

  it('applies and validates broker settings', async () => {
    expect(await demo.updateBrokerFault({ mode: 'PARTIAL_FAILURES' })).toMatchObject({ failureRatePercent: 50 });
    expect((await demo.fetchStats()).brokerMode).toBe('PARTIAL_FAILURES');
    await expect(demo.updateBrokerFault({ simulatedLatencyMs: -1 })).rejects.toThrow(/simulatedLatencyMs/);
  });

  it('repeats the same partial-failure outcomes after a reset', async () => {
    const outcome = async () => {
      demo.resetDemoData();
      await demo.updateBrokerFault({ mode: 'PARTIAL_FAILURES', simulatedLatencyMs: 0 });
      const p = demo.triggerPoll();
      await vi.advanceTimersByTimeAsync(0);
      const r = await p;
      return [r.dispatchedCount, r.failedCount];
    };
    expect(await outcome()).toEqual(await outcome());
  });

  it('records the consumer inbox in camelCase', async () => {
    const inbox = await demo.fetchConsumerInbox();
    expect(inbox).toHaveLength(24);
    expect(inbox.some((i) => i.duplicateDetected)).toBe(true);
    expect(inbox[0]).toHaveProperty('consumerId');
  });
});

describe('demo mode switch and banner', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shows nothing outside demo mode', async () => {
    vi.stubEnv('VITE_DEMO_MODE', 'false');
    vi.resetModules();
    const { DemoBanner } = await import('../components/DemoBanner.js');
    const { container } = render(<DemoBanner onReset={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the demo bar and resets sample data after confirmation', async () => {
    vi.stubEnv('VITE_DEMO_MODE', 'true');
    vi.resetModules();
    const { DemoBanner } = await import('../components/DemoBanner.js');
    const services = await import('../services/index.js');
    expect(services.isDemoMode).toBe(true);
    const onReset = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<DemoBanner onReset={onReset} />);
    expect(screen.getByText('Demo: everything runs in your browser with sample data.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', 'https://github.com/Taan1el/outboxrelay');

    const user = userEvent.setup();
    await services.createOrder(order);
    await user.click(screen.getByRole('button', { name: 'Reset sample data' }));
    expect(onReset).not.toHaveBeenCalled();
    expect((await services.fetchStats()).totalOrders).toBe(15);
    await user.click(screen.getByRole('button', { name: 'Reset sample data' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect((await services.fetchStats()).totalOrders).toBe(14);
    confirm.mockRestore();
  });
});
