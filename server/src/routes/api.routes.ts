import { Router } from 'express';
import { OutboxController } from '../controllers/outbox.controller.js';
import { OutboxService } from '../services/outbox.service.js';

export function createApiRouter(service: OutboxService): Router {
  const router = Router();
  const controller = new OutboxController(service);

  // Health check
  router.get('/health', (_req, res) => {
    const stats = service.getStats();
    res.json({
      status: 'ok',
      service: 'OutboxRelay',
      totalOrders: stats.totalOrders,
      pendingEvents: stats.pendingEvents,
      successRate: stats.deliverySuccessRate,
      brokerMode: stats.brokerMode,
    });
  });

  // Telemetry & Stats
  router.get('/stats', controller.getStats);

  // Orders (Business Entity)
  router.get('/orders', controller.getOrders);
  router.post('/orders', controller.createOrder);

  // Outbox Events
  router.get('/outbox/events', controller.getOutboxEvents);
  router.post('/outbox/poll', controller.triggerPoll);
  router.post('/outbox/events/:id/retry', controller.retryDeadLetter);

  // Consumer Inbox Audit
  router.get('/consumer/inbox', controller.getConsumerInbox);

  // Broker Fault Injection
  router.post('/broker/fault-config', controller.setBrokerFaultConfig);

  return router;
}