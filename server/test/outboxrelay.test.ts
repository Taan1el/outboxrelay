import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { OutboxDatabase } from '../src/db/database.js';
import { OutboxService } from '../src/services/outbox.service.js';
import { createApp } from '../src/app.js';

describe('OutboxDatabase & ACID Dual-Write Engine', () => {
  let db: OutboxDatabase;

  beforeEach(() => {
    db = new OutboxDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('atomically creates order entity and outbox event in single transaction', () => {
    const order = {
      id: 'ord_unit_1',
      customerId: 'cust_unit_1',
      itemsCount: 3,
      totalEur: 120.0,
      currency: 'EUR',
      status: 'CONFIRMED' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const event = {
      id: 'evt_unit_1',
      aggregateType: 'Order',
      aggregateId: 'ord_unit_1',
      eventType: 'ORDER_CONFIRMED',
      payload: { itemsCount: 3, totalEur: 120.0 },
      status: 'PENDING' as const,
      retryCount: 0,
      leasedUntil: null,
      createdAt: new Date().toISOString(),
      publishedAt: null,
      errorMessage: null,
    };

    db.createOrderWithOutboxEvent(order, event);

    const orders = db.getOrders();
    expect(orders.some((o) => o.id === 'ord_unit_1')).toBe(true);

    const events = db.getOutboxEvents('PENDING');
    expect(events.some((e) => e.id === 'evt_unit_1')).toBe(true);
  });

  it('leases pending events safely and prevents duplicate leasing during lease duration', () => {
    const leased = db.leasePendingEvents(5, 10);
    expect(leased.length).toBeGreaterThan(0);

    // Second immediate lease call should find 0 events because existing are leased
    const leasedAgain = db.leasePendingEvents(5, 10);
    expect(leasedAgain.length).toBe(0);
  });

  it('transitions to DEAD_LETTER when retry count reaches max retries', () => {
    const events = db.getOutboxEvents();
    const target = events[0];

    const fail1 = db.markEventFailed(target.id, 'Timeout error 1', 3);
    expect(fail1.status).toBe('PENDING');

    const fail2 = db.markEventFailed(target.id, 'Timeout error 2', 3);
    expect(fail2.status).toBe('PENDING');

    const fail3 = db.markEventFailed(target.id, 'Timeout error 3', 3);
    expect(fail3.status).toBe('DEAD_LETTER');

    const dlEvents = db.getOutboxEvents('DEAD_LETTER');
    expect(dlEvents.some((e) => e.id === target.id)).toBe(true);
  });

  it('deduplicates consumer processing in consumer inbox', () => {
    const res1 = db.recordConsumerInbox('evt_test_dedup', 'consumer_billing', 'ORDER_CREATED');
    expect(res1.duplicate).toBe(false);

    const res2 = db.recordConsumerInbox('evt_test_dedup', 'consumer_billing', 'ORDER_CREATED');
    expect(res2.duplicate).toBe(true);
  });
});

describe('OutboxRelay Service & REST API', () => {
  let app: any;
  let service: OutboxService;
  let db: OutboxDatabase;

  beforeEach(() => {
    db = new OutboxDatabase(':memory:');
    service = new OutboxService(db);
    service.stopBackgroundPoller(); // manual control during tests
    const created = createApp(service);
    app = created.app;
  });

  afterEach(() => {
    service.stopBackgroundPoller();
    db.close();
  });

  it('GET /api/health returns broker health and status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('OutboxRelay');
    expect(res.body.brokerMode).toBe('HEALTHY');
  });

  it('POST /api/orders creates order and outbox event atomically', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        customerId: 'cust_tartu_99',
        items: [
          { name: 'Cloud Node', quantity: 2, unitPriceEur: 50 },
          { name: 'Static IP', quantity: 1, unitPriceEur: 15 },
        ],
        currency: 'EUR',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.order.totalEur).toBe(115);
    expect(res.body.data.event.status).toBe('PENDING');
  });

  it('POST /api/outbox/poll dispatches pending events and marks them PUBLISHED', async () => {
    // Create new order
    await request(app)
      .post('/api/orders')
      .send({
        customerId: 'cust_auto_dispatch',
        items: [{ name: 'Telemetry Pack', quantity: 1, unitPriceEur: 75 }],
      });

    const pollRes = await request(app).post('/api/outbox/poll').send({ batchSize: 10 });
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.data.dispatchedCount).toBeGreaterThan(0);

    const statsRes = await request(app).get('/api/stats');
    expect(statsRes.body.data.publishedEvents).toBeGreaterThan(0);
  });

  it('handles broker fault injection and dead-letter routing', async () => {
    // Inject full outage
    await request(app)
      .post('/api/broker/fault-config')
      .send({ mode: 'FULL_OUTAGE', simulatedLatencyMs: 0 });

    // Create order
    const orderRes = await request(app)
      .post('/api/orders')
      .send({
        customerId: 'cust_fail_test',
        items: [{ name: 'Test item', quantity: 1, unitPriceEur: 10 }],
      });

    const eventId = orderRes.body.data.event.id;

    // Poll 3 times to trigger 3 failures and dead-letter transition
    await request(app).post('/api/outbox/poll').send({ batchSize: 5 });
    await request(app).post('/api/outbox/poll').send({ batchSize: 5 });
    await request(app).post('/api/outbox/poll').send({ batchSize: 5 });

    const eventsRes = await request(app).get('/api/outbox/events?status=DEAD_LETTER');
    expect(eventsRes.body.data.some((e: any) => e.id === eventId)).toBe(true);

    // Test retry from dead-letter
    const retryRes = await request(app).post(`/api/outbox/events/${eventId}/retry`);
    expect(retryRes.status).toBe(200);

    const checkRes = await request(app).get('/api/outbox/events?status=PENDING');
    expect(checkRes.body.data.some((e: any) => e.id === eventId)).toBe(true);
  });
});