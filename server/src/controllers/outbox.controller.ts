import type { Request, Response } from 'express';
import { OutboxService } from '../services/outbox.service.js';
import {
  PollOptionsError,
  ValidationError,
  validateFaultConfig,
  validateOrderPayload,
} from '../../../shared/outbox-logic.js';

const STATUS_FILTERS = ['ALL', 'PENDING', 'LEASED', 'PUBLISHED', 'DEAD_LETTER'];

function fail(res: Response, err: unknown): void {
  const badRequest = err instanceof PollOptionsError || err instanceof ValidationError;
  const message = err instanceof Error ? err.message : 'Unexpected error';
  res.status(badRequest ? 400 : 500).json({ success: false, error: message });
}

export class OutboxController {
  constructor(private outboxService: OutboxService) {}

  public getStats = async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: this.outboxService.getStats() });
    } catch (err) {
      fail(res, err);
    }
  };

  public getOrders = async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: this.outboxService.getOrders() });
    } catch (err) {
      fail(res, err);
    }
  };

  public createOrder = async (req: Request, res: Response) => {
    try {
      const payload = validateOrderPayload(req.body);
      const result = this.outboxService.createOrder(payload);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      fail(res, err);
    }
  };

  public getOutboxEvents = async (req: Request, res: Response) => {
    try {
      const status = req.query.status;
      if (status !== undefined && (typeof status !== 'string' || !STATUS_FILTERS.includes(status))) {
        throw new ValidationError(`status must be one of ${STATUS_FILTERS.join(', ')}`);
      }
      res.json({ success: true, data: this.outboxService.getOutboxEvents(status) });
    } catch (err) {
      fail(res, err);
    }
  };

  public triggerPoll = async (req: Request, res: Response) => {
    try {
      const body = req.body === undefined ? {} : req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new PollOptionsError('Polling options must be a JSON object');
      }
      const { batchSize, leaseSeconds } = body;
      const result = await this.outboxService.pollAndRelay(batchSize, leaseSeconds);
      res.json({ success: true, data: result });
    } catch (err) {
      fail(res, err);
    }
  };

  public retryDeadLetter = async (req: Request, res: Response) => {
    try {
      const rawId = req.params.id;
      const eventId = Array.isArray(rawId) ? rawId[0] : String(rawId);
      if (!this.outboxService.retryDeadLetterEvent(eventId)) {
        res.status(404).json({ success: false, error: `Event '${eventId}' not found in DEAD_LETTER status` });
        return;
      }
      res.json({ success: true, message: `Event ${eventId} reset to PENDING for retry` });
    } catch (err) {
      fail(res, err);
    }
  };

  public getConsumerInbox = async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: this.outboxService.getConsumerInbox() });
    } catch (err) {
      fail(res, err);
    }
  };

  public setBrokerFaultConfig = async (req: Request, res: Response) => {
    try {
      const patch = validateFaultConfig(req.body);
      res.json({ success: true, data: this.outboxService.setBrokerFaultConfig(patch) });
    } catch (err) {
      fail(res, err);
    }
  };
}
