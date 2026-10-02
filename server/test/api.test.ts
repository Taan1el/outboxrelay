import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutboxDatabase } from '../src/db/database.js';
import { OutboxService } from '../src/services/outbox.service.js';
import { createApp } from '../src/app.js';
import { defaultDatabasePath, repoRoot } from '../src/lib/repoPaths.js';

const goodOrder = { customerId: 'cust_api', items: [{ name: 'Pack', quantity: 2, unitPriceEur: 12.5 }] };

describe('REST API validation and responses', () => {
  let db: OutboxDatabase;
  let service: OutboxService;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    db = new OutboxDatabase(':memory:');
    service = new OutboxService(db, false);
    service.setBrokerFaultConfig({ simulatedLatencyMs: 0 });
    app = createApp(service).app;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('creates an order, its outbox event and the totals in one call', async () => {
    const res = await request(app).post('/api/orders').send(goodOrder);
    expect(res.status).toBe(201);
    expect(res.body.data.order).toMatchObject({ itemsCount: 2, totalEur: 25, status: 'CONFIRMED' });
    expect(res.body.data.event).toMatchObject({ aggregateId: res.body.data.order.id, status: 'PENDING' });
    expect(db.getStats().totalOrders).toBe(3);
  });

  it.each([
    [{}],
    [{ customerId: 'c', items: [] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: -1, unitPriceEur: 5 }] }],
    [{ customerId: 'c', items: [{ name: 'a', quantity: 1, unitPriceEur: 'free' }] }],
  ])('rejects invalid order %j without writing anything', async (body) => {
    const before = db.getStats();
    const res = await request(app).post('/api/orders').send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(db.getStats()).toEqual(before);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await request(app).post('/api/orders').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });

  it('filters events by status and rejects unknown statuses', async () => {
    const published = await request(app).get('/api/outbox/events?status=PUBLISHED');
    expect(published.status).toBe(200);
    expect(published.body.data.every((e: { status: string }) => e.status === 'PUBLISHED')).toBe(true);
    const all = await request(app).get('/api/outbox/events?status=ALL');
    expect(all.body.data.length).toBe(2);
    expect((await request(app).get('/api/outbox/events?status=NOPE')).status).toBe(400);
  });

  it('validates fault configuration and applies valid changes', async () => {
    expect((await request(app).post('/api/broker/fault-config').send({ mode: 'EXPLODING' })).status).toBe(400);
    expect((await request(app).post('/api/broker/fault-config').send({ simulatedLatencyMs: -1 })).status).toBe(400);
    const ok = await request(app).post('/api/broker/fault-config').send({ mode: 'PARTIAL_FAILURES', failureRatePercent: 25 });
    expect(ok.body.data).toMatchObject({ mode: 'PARTIAL_FAILURES', failureRatePercent: 25 });
    const stats = await request(app).get('/api/stats');
    expect(stats.body.data.brokerMode).toBe('PARTIAL_FAILURES');
  });

  it('returns 404 when replaying an event that is not dead-lettered', async () => {
    const res = await request(app).post('/api/outbox/events/evt_outbox_101/retry');
    expect(res.status).toBe(404);
    expect((await request(app).post('/api/outbox/events/missing/retry')).status).toBe(404);
  });

  it('relays a pending event to every consumer and reports per-consumer counts', async () => {
    const poll = await request(app).post('/api/outbox/poll').send({});
    expect(poll.body.data).toMatchObject({ leasedCount: 1, dispatchedCount: 1, failedCount: 0 });
    const stats = (await request(app).get('/api/stats')).body.data;
    expect(stats.consumers).toHaveLength(3);
    expect(stats.consumers.every((c: { processed: number }) => c.processed === 1)).toBe(true);
    const inbox = (await request(app).get('/api/consumer/inbox')).body.data;
    expect(inbox).toHaveLength(3);
    expect(inbox[0]).toEqual(expect.objectContaining({ consumerId: expect.any(String), duplicateDetected: false }));
  });

  it('backs off failed events and dead-letters them on the third failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'));
    service.setBrokerFaultConfig({ mode: 'FULL_OUTAGE' });

    const first = await request(app).post('/api/outbox/poll').send({});
    expect(first.body.data).toMatchObject({ leasedCount: 1, failedCount: 1, deadLetterCount: 0 });
    // Still inside the 2 second backoff: nothing is due.
    expect((await request(app).post('/api/outbox/poll').send({})).body.data.leasedCount).toBe(0);

    vi.setSystemTime(Date.now() + 2000);
    expect((await request(app).post('/api/outbox/poll').send({})).body.data.failedCount).toBe(1);
    vi.setSystemTime(Date.now() + 4000);
    const third = await request(app).post('/api/outbox/poll').send({});
    expect(third.body.data).toMatchObject({ failedCount: 1, deadLetterCount: 1 });

    const dead = (await request(app).get('/api/outbox/events?status=DEAD_LETTER')).body.data;
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ retryCount: 3, errorMessage: expect.stringContaining('ECONNREFUSED') });
    expect((await request(app).get('/api/stats')).body.data.deliverySuccessRate).toBe(50);
  });

  it('serves a lease again only after it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T10:00:00Z'));
    db.leasePendingEvents(5, 10);
    expect((await request(app).post('/api/outbox/poll').send({ leaseSeconds: 5 })).body.data.leasedCount).toBe(0);
    vi.setSystemTime(Date.now() + 6000);
    expect((await request(app).post('/api/outbox/poll').send({ leaseSeconds: 5 })).body.data.leasedCount).toBe(1);
  });

  it('reports health with the broker mode', async () => {
    service.setBrokerFaultConfig({ mode: 'FULL_OUTAGE' });
    const res = await request(app).get('/api/health');
    expect(res.body).toMatchObject({ status: 'ok', brokerMode: 'FULL_OUTAGE', pendingEvents: 1 });
  });
});

describe('background poller', () => {
  it('relays pending events on its interval and stops when asked', async () => {
    vi.useFakeTimers();
    const db = new OutboxDatabase(':memory:');
    const service = new OutboxService(db, false);
    service.setBrokerFaultConfig({ simulatedLatencyMs: 0 });
    service.startBackgroundPoller(1000);
    service.startBackgroundPoller(1000); // second start is a no-op
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.getStats().publishedEvents).toBe(2);
    service.stopBackgroundPoller();
    service.createOrder(goodOrder);
    await vi.advanceTimersByTimeAsync(5000);
    expect(db.getStats().pendingEvents).toBe(1);
    db.close();
    vi.useRealTimers();
  });
});

describe('paths', () => {
  const original = process.env.OUTBOXRELAY_DB_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.OUTBOXRELAY_DB_PATH;
    else process.env.OUTBOXRELAY_DB_PATH = original;
  });

  it('puts the database under data/ at the repository root by default', () => {
    delete process.env.OUTBOXRELAY_DB_PATH;
    expect(defaultDatabasePath()).toBe(path.join(repoRoot(), 'data', 'outbox.db'));
    expect(JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')).name).toBe('outboxrelay');
  });

  it('honours OUTBOXRELAY_DB_PATH', () => {
    process.env.OUTBOXRELAY_DB_PATH = path.join(os.tmpdir(), 'custom.db');
    expect(defaultDatabasePath()).toBe(path.join(os.tmpdir(), 'custom.db'));
  });
});
