import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutboxDatabase } from '../src/db/database.js';

describe('consumer receipts across SQLite connections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-receipts-'));
  const first = new OutboxDatabase(path.join(dir, 'outbox.sqlite'));
  const second = new OutboxDatabase(path.join(dir, 'outbox.sqlite'));

  afterEach(() => {
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves one receipt and counts replays from either connection', () => {
    expect(first.recordConsumerInbox('event-shared', 'consumer-inventory', 'ORDER_CREATED')).toEqual({ duplicate: false });
    expect(second.recordConsumerInbox('event-shared', 'consumer-inventory', 'ORDER_CREATED')).toEqual({ duplicate: true });
    expect(first.recordConsumerInbox('event-shared', 'consumer-inventory', 'ORDER_CREATED')).toEqual({ duplicate: true });

    const receipts = second.getConsumerInbox().filter((row) => row.eventId === 'event-shared');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ consumerId: 'consumer-inventory', duplicateDetected: true });
    expect(first.getStats().consumers.find((row) => row.consumerId === 'consumer-inventory')?.duplicatesRejected).toBe(2);
  });
});
