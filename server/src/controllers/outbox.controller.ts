import type { Request, Response } from 'express';
import { OutboxService } from '../services/outbox.service.js';

export class OutboxController {
  constructor(private outboxService: OutboxService) {}

  public getStats = async (_req: Request, res: Response) => {
    try {
      const stats = this.outboxService.getStats();
      res.json({ success: true, data: stats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public getOrders = async (_req: Request, res: Response) => {
    try {
      const orders = this.outboxService.getOrders();
      res.json({ success: true, data: orders });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public createOrder = async (req: Request, res: Response) => {
    try {
      const { customerId, items, currency } = req.body;
      if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
        res.status(400).json({ success: false, error: 'customerId and non-empty items array are required' });
        return;
      }

      const result = this.outboxService.createOrder({ customerId, items, currency });
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public getOutboxEvents = async (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const events = this.outboxService.getOutboxEvents(status);
      res.json({ success: true, data: events });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public triggerPoll = async (req: Request, res: Response) => {
    try {
      const batchSize = req.body.batchSize ? parseInt(req.body.batchSize, 10) : 10;
      const leaseSeconds = req.body.leaseSeconds ? parseInt(req.body.leaseSeconds, 10) : 5;
      const result = await this.outboxService.pollAndRelay(batchSize, leaseSeconds);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public retryDeadLetter = async (req: Request, res: Response) => {
    try {
      const rawId = req.params.id;
      const eventId = Array.isArray(rawId) ? rawId[0] : String(rawId);
      const retried = this.outboxService.retryDeadLetterEvent(eventId);
      if (!retried) {
        res.status(404).json({ success: false, error: `Event '${eventId}' not found in DEAD_LETTER status` });
        return;
      }
      res.json({ success: true, message: `Event ${eventId} reset to PENDING for retry` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public getConsumerInbox = async (_req: Request, res: Response) => {
    try {
      const inbox = this.outboxService.getConsumerInbox();
      res.json({ success: true, data: inbox });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public setBrokerFaultConfig = async (req: Request, res: Response) => {
    try {
      const updated = this.outboxService.setBrokerFaultConfig(req.body);
      res.json({ success: true, data: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };
}