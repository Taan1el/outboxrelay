import { describe, it, expect, vi } from 'vitest';
import {
  DeadLetterParseError,
  NO_ERROR_KEY,
  fromOutboxEvents,
  groupByError,
  normalizeError,
  parseDeadLetterFile,
  replayInBatches,
  ReplayBatchError,
  toReplayCsv,
  toReplayJson,
  type DeadLetterRecord,
} from '../utils/deadLetters.js';
import type { OutboxEvent } from '../../../shared/types.js';

const csv = [
  'id,type,payload,retry_count,last_error',
  'evt_1,ORDER_CREATED,"{""orderId"":""ord_1""}",3,Broker timeout after 3012 ms',
  'evt_2,ORDER_CREATED,,3,Broker timeout after 2990 ms',
  'evt_3,ORDER_CONFIRMED,plain text,2,"Broker refused, HTTP 503"',
].join('\r\n');

function parseError(name: string, text: string): string {
  try {
    parseDeadLetterFile(name, text);
  } catch (err) {
    expect(err).toBeInstanceOf(DeadLetterParseError);
    return (err as Error).message;
  }
  throw new Error('expected the file to be rejected');
}

describe('parseDeadLetterFile, CSV', () => {
  it('reads quoted fields, JSON payloads, plain payloads and empty payloads', () => {
    const records = parseDeadLetterFile('dead.csv', csv);
    expect(records).toEqual([
      { id: 'evt_1', type: 'ORDER_CREATED', payload: { orderId: 'ord_1' }, retryCount: 3, lastError: 'Broker timeout after 3012 ms' },
      { id: 'evt_2', type: 'ORDER_CREATED', payload: null, retryCount: 3, lastError: 'Broker timeout after 2990 ms' },
      { id: 'evt_3', type: 'ORDER_CONFIRMED', payload: 'plain text', retryCount: 2, lastError: 'Broker refused, HTTP 503' },
    ]);
  });

  it('accepts columns in any order, a byte order mark, LF rows and a trailing newline', () => {
    const text = '﻿last_error,retry_count,id,type,payload\nTimeout,1,evt_9,ORDER_CREATED,{}\n';
    expect(parseDeadLetterFile('dead.csv', text)).toEqual([
      { id: 'evt_9', type: 'ORDER_CREATED', payload: {}, retryCount: 1, lastError: 'Timeout' },
    ]);
  });

  it('keeps line breaks inside a quoted error', () => {
    const text = 'id,type,payload,retry_count,last_error\nevt_1,T,,1,"first line\nsecond line"\n';
    expect(parseDeadLetterFile('dead.csv', text)[0].lastError).toBe('first line\nsecond line');
  });

  it('names the missing columns', () => {
    expect(parseError('dead.csv', 'id,type,payload\nevt_1,T,')).toBe(
      'dead.csv, row 1: missing columns retry_count, last_error. Expected id,type,payload,retry_count,last_error.',
    );
  });

  it('names the row and field for a bad retry count', () => {
    const text = 'id,type,payload,retry_count,last_error\nevt_1,T,,3,x\nevt_2,T,,-1,x';
    expect(parseError('dead.csv', text)).toBe('dead.csv, row 3, retry_count: expected a whole number of 0 or more, found "-1".');
  });

  it('rejects a row with the wrong number of fields', () => {
    const text = 'id,type,payload,retry_count,last_error\nevt_1,T,,3';
    expect(parseError('dead.csv', text)).toBe('dead.csv, row 2: expected 5 fields, found 4.');
  });

  it('rejects an empty id', () => {
    const text = 'id,type,payload,retry_count,last_error\n ,T,,3,x';
    expect(parseError('dead.csv', text)).toBe('dead.csv, row 2, id: expected a non-empty value.');
  });

  it('rejects an unclosed quote with its starting line', () => {
    const text = 'id,type,payload,retry_count,last_error\nevt_1,T,"{oops,3,x\n';
    expect(parseError('dead.csv', text)).toBe('dead.csv, line 2: a quoted field is never closed.');
  });

  it('rejects a header with no rows and an empty file', () => {
    expect(parseError('dead.csv', 'id,type,payload,retry_count,last_error\n')).toBe('dead.csv has no dead-letter rows.');
    expect(parseError('dead.csv', '  \n')).toBe('dead.csv is empty.');
  });

  it('rejects a repeated id and says where it first appeared', () => {
    const text = 'id,type,payload,retry_count,last_error\nevt_1,T,,3,x\nevt_1,T,,3,x';
    expect(parseError('dead.csv', text)).toBe('dead.csv, row 3: id "evt_1" already appears at row 2.');
  });
});

describe('parseDeadLetterFile, JSON', () => {
  it('reads the CSV field names', () => {
    const text = JSON.stringify([{ id: 'evt_1', type: 'T', payload: { a: 1 }, retry_count: 3, last_error: 'Timeout' }]);
    expect(parseDeadLetterFile('dead.json', text)).toEqual([
      { id: 'evt_1', type: 'T', payload: { a: 1 }, retryCount: 3, lastError: 'Timeout' },
    ]);
  });

  it('reads a saved API response with its envelope and event field names', () => {
    const text = JSON.stringify({
      success: true,
      data: [{ id: 'evt_1', eventType: 'ORDER_CREATED', payload: {}, retryCount: 3, errorMessage: null, status: 'DEAD_LETTER' }],
    });
    expect(parseDeadLetterFile('export.json', text)).toEqual([
      { id: 'evt_1', type: 'ORDER_CREATED', payload: {}, retryCount: 3, lastError: '' },
    ]);
  });

  it('detects JSON by content when the file has another extension', () => {
    const text = '[{"id":"evt_1","type":"T","retry_count":0,"last_error":"x"}]';
    expect(parseDeadLetterFile('dead.txt', text)).toHaveLength(1);
  });

  it('names the item and field that is wrong', () => {
    expect(parseError('dead.json', '[{"id":"evt_1","type":"T","retry_count":1}, {"id":"evt_2","retry_count":1}]')).toBe(
      'dead.json, item 1, type or eventType: expected a non-empty string.',
    );
    expect(parseError('dead.json', '[{"id":"evt_1","type":"T","retry_count":1.5}]')).toBe(
      'dead.json, item 0, retry_count: expected a whole number of 0 or more, found 1.5.',
    );
    expect(parseError('dead.json', '[{"id":"evt_1","type":"T","retry_count":1,"last_error":42}]')).toBe(
      'dead.json, item 0, last_error: expected text or null, found number.',
    );
    expect(parseError('dead.json', '[3]')).toBe('dead.json, item 0: expected an object.');
  });

  it('rejects invalid JSON and a top level that is not an array', () => {
    expect(parseError('dead.json', '[{')).toMatch(/^dead\.json is not valid JSON: /);
    expect(parseError('dead.json', '{"id":"evt_1"}')).toBe('dead.json: expected a JSON array of events at the top level.');
  });

  it('rejects a repeated id by item index', () => {
    const item = { id: 'evt_1', type: 'T', retry_count: 1 };
    expect(parseError('dead.json', JSON.stringify([item, item]))).toBe('dead.json, item 1: id "evt_1" already appears at item 0.');
  });
});

describe('normalizeError', () => {
  it('merges failures that differ only in durations, sizes and identifiers', () => {
    expect(normalizeError('Broker timeout after 3012 ms')).toBe('Broker timeout after <n> ms');
    expect(normalizeError('Broker timeout after 2.5s')).toBe('Broker timeout after <n>s');
    expect(normalizeError('Payload for evt_8f3a2 is 2048 bytes')).toBe('Payload for <id> is <n> bytes');
    expect(normalizeError('Lock held by 3f2c9a1e-0b7d-4c55-9a51-0e3b2d4c5f60')).toBe('Lock held by <id>');
    expect(normalizeError('Message 1700000000123 rejected')).toBe('Message <n> rejected');
  });

  it('keeps short status codes so different errors stay apart', () => {
    expect(normalizeError('HTTP 503 from broker')).toBe('HTTP 503 from broker');
    expect(normalizeError('HTTP 504 from broker')).not.toBe(normalizeError('HTTP 503 from broker'));
  });

  it('collapses whitespace and names a missing error', () => {
    expect(normalizeError('  Broker\n  refused  ')).toBe('Broker refused');
    expect(normalizeError('')).toBe(NO_ERROR_KEY);
  });
});

describe('groupByError', () => {
  it('groups by normalized error, largest group first, with types and attempt range', () => {
    const groups = groupByError(parseDeadLetterFile('dead.csv', csv));
    expect(groups.map((g) => [g.key, g.records.map((r) => r.id)])).toEqual([
      ['Broker timeout after <n> ms', ['evt_1', 'evt_2']],
      ['Broker refused, HTTP 503', ['evt_3']],
    ]);
    expect(groups[0]).toMatchObject({ sample: 'Broker timeout after 3012 ms', types: ['ORDER_CREATED'], minAttempts: 3, maxAttempts: 3 });
  });

  it('breaks ties by error text and lists event types once, sorted', () => {
    const records: DeadLetterRecord[] = [
      { id: 'a', type: 'Z', payload: null, retryCount: 1, lastError: 'b failed' },
      { id: 'b', type: 'A', payload: null, retryCount: 3, lastError: 'a failed' },
      { id: 'c', type: 'Z', payload: null, retryCount: 2, lastError: 'a failed' },
      { id: 'd', type: 'Z', payload: null, retryCount: 1, lastError: 'c failed' },
    ];
    const groups = groupByError(records);
    expect(groups.map((g) => g.key)).toEqual(['a failed', 'b failed', 'c failed']);
    expect(groups[0]).toMatchObject({ types: ['A', 'Z'], minAttempts: 2, maxAttempts: 3 });
  });
});

describe('replay lists', () => {
  const records = parseDeadLetterFile('dead.csv', csv);

  it('writes a JSON array of ids', () => {
    expect(JSON.parse(toReplayJson(records))).toEqual(['evt_1', 'evt_2', 'evt_3']);
  });

  it('writes CSV that the importer reads back unchanged', () => {
    const written = toReplayCsv(records);
    expect(written.split('\r\n')[0]).toBe('id,type,payload,retry_count,last_error');
    expect(written).toContain('"Broker refused, HTTP 503"');
    expect(parseDeadLetterFile('replay.csv', written)).toEqual(records);
  });
});

describe('fromOutboxEvents', () => {
  it('keeps only dead-lettered events and maps their fields', () => {
    const base = {
      aggregateType: 'Order',
      aggregateId: 'ord_1',
      payload: { totalEur: 10 },
      leasedUntil: null,
      availableAt: null,
      createdAt: '2026-03-01T10:00:00.000Z',
      publishedAt: null,
    };
    const events: OutboxEvent[] = [
      { ...base, id: 'evt_dead', eventType: 'ORDER_CREATED', status: 'DEAD_LETTER', retryCount: 3, errorMessage: ' Connection refused ' },
      { ...base, id: 'evt_live', eventType: 'ORDER_CREATED', status: 'PENDING', retryCount: 1, errorMessage: 'Timeout' },
    ];
    expect(fromOutboxEvents(events)).toEqual([
      { id: 'evt_dead', type: 'ORDER_CREATED', payload: { totalEur: 10 }, retryCount: 3, lastError: 'Connection refused' },
    ]);
  });
});

describe('replayInBatches', () => {
  it('sends unique ids in batches and merges the results in order', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `evt_${i}`);
    const send = vi.fn(async (batch: string[]) => ({
      retried: batch.filter((id) => !id.endsWith('7')),
      skipped: batch.filter((id) => id.endsWith('7')),
    }));

    const result = await replayInBatches([...ids, 'evt_0', 'evt_5'], 500, send);

    expect(send.mock.calls.map(([batch]) => batch.length)).toEqual([500, 500, 201]);
    expect(send.mock.calls[0][0][0]).toBe('evt_0');
    expect(send.mock.calls[2][0].at(-1)).toBe('evt_1200');
    expect(result.retried).toHaveLength(1201 - 120);
    expect(result.skipped).toHaveLength(120);
    expect(new Set([...result.retried, ...result.skipped]).size).toBe(1201);
  });

  it('stops at the first failed batch and reports what was already replayed', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const send = vi
      .fn()
      .mockResolvedValueOnce({ retried: ['a'], skipped: ['b'] })
      .mockRejectedValueOnce(new Error('Failed to replay events: 503'));

    const error = await replayInBatches(ids, 2, send).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ReplayBatchError);
    expect((error as ReplayBatchError).message).toBe('Failed to replay events: 503');
    expect((error as ReplayBatchError).partial).toEqual({ retried: ['a'], skipped: ['b'] });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
