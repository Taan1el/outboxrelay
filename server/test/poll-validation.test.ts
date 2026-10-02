import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { OutboxDatabase } from '../src/db/database.js';
import { OutboxService } from '../src/services/outbox.service.js';
import { createApp } from '../src/app.js';

describe('manual polling bounds', () => {
  let db: OutboxDatabase;
  let service: OutboxService;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    db = new OutboxDatabase(':memory:');
    service = new OutboxService(db);
    service.stopBackgroundPoller();
    service.setBrokerFaultConfig({ simulatedLatencyMs: 0 });
    app = createApp(service).app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  for (const [field, maximum] of [['batchSize', 100], ['leaseSeconds', 300]] as const) {
    it.each([null, false, true, 0, -1, 1.5, maximum + 1, '2', '2events', [], {}])(
      `rejects invalid ${field} %j without changing delivery state`, async (value) => {
        const events = db.getOutboxEvents();
        const stats = db.getStats();
        const response = await request(app).post('/api/outbox/poll').send({ [field]: value });
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          success: false,
          error: `${field} must be an integer between 1 and ${maximum}`,
        });
        expect(db.getOutboxEvents()).toEqual(events);
        expect(db.getStats()).toEqual(stats);
      },
    );
  }

  it.each([{ body: [] }, { body: ['invalid'] }])('rejects array request bodies $body', async ({ body }) => {
    const response = await request(app).post('/api/outbox/poll').send(body);
    expect(response.status).toBe(400);
    expect(db.getStats().pendingEvents).toBe(1);
  });

  it('uses defaults when both options are omitted', async () => {
    const lease = vi.spyOn(db, 'leasePendingEvents');
    const response = await request(app).post('/api/outbox/poll').send({});
    expect(response.status).toBe(200);
    expect(lease).toHaveBeenCalledWith(5, 10);
    expect(response.body.data.dispatchedCount).toBe(1);
  });

  it.each([[1, 1], [100, 300]])('accepts boundary batch %i and lease %i', async (batchSize, leaseSeconds) => {
    const lease = vi.spyOn(db, 'leasePendingEvents');
    const response = await request(app).post('/api/outbox/poll').send({ batchSize, leaseSeconds });
    expect(response.status).toBe(200);
    expect(lease).toHaveBeenCalledWith(leaseSeconds, batchSize);
  });

  it.each([[NaN, 5], [Infinity, 5], [10, NaN], [10, Infinity], [-1, 5], [10, 0]])(
    'rejects invalid service options before claiming rows (%s, %s)', async (batchSize, leaseSeconds) => {
      const lease = vi.spyOn(db, 'leasePendingEvents');
      await expect(service.pollAndRelay(batchSize, leaseSeconds)).rejects.toThrow(/must be an integer/);
      expect(lease).not.toHaveBeenCalled();
    },
  );

  it('never claims more than the requested batch', async () => {
    service.createOrder({ customerId: 'cust_batch', items: [{ name: 'Item', quantity: 1, unitPriceEur: 5 }] });
    const response = await request(app).post('/api/outbox/poll').send({ batchSize: 1 });
    expect(response.status).toBe(200);
    expect(response.body.data.leasedCount).toBe(1);
    expect(db.getStats().pendingEvents).toBe(1);
  });
});
