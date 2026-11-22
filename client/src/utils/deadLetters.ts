// Reads dead-letter exports (JSON or CSV), groups them by their last error and
// writes replay lists. Pure functions: no DOM, no network, so every rule here is
// covered by unit tests and runs the same in the console and the browser demo.
import type { OutboxEvent } from '../../../shared/types.js';

export interface DeadLetterRecord {
  id: string;
  type: string;
  payload: unknown;
  retryCount: number;
  lastError: string;
}

export interface ErrorGroup {
  /** Normalized error text; numbers and identifiers are replaced so similar failures share a group. */
  key: string;
  /** The first raw error seen for this group, shown next to the normalized key. */
  sample: string;
  records: DeadLetterRecord[];
  types: string[];
  minAttempts: number;
  maxAttempts: number;
}

export class DeadLetterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterParseError';
  }
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDS = 10_000;
export const NO_ERROR_KEY = '(no error recorded)';

const CSV_COLUMNS = ['id', 'type', 'payload', 'retry_count', 'last_error'] as const;

// Each field accepts the column name from the CSV header and the field name the
// OutboxRelay API uses, so a saved `GET /api/outbox/events?status=DEAD_LETTER`
// response (its `data` array) loads without editing.
const FIELD_ALIASES = {
  id: ['id'],
  type: ['type', 'eventType'],
  payload: ['payload'],
  retryCount: ['retry_count', 'retryCount'],
  lastError: ['last_error', 'errorMessage'],
} as const;

export function parseDeadLetterFile(fileName: string, text: string): DeadLetterRecord[] {
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') {
    throw new DeadLetterParseError(`${fileName} is empty.`);
  }
  const lower = fileName.toLowerCase();
  const looksJson = lower.endsWith('.json') || (!lower.endsWith('.csv') && /^\s*[[{]/.test(body));
  const records = looksJson ? parseJson(fileName, body) : parseCsv(fileName, body);
  if (records.length === 0) {
    throw new DeadLetterParseError(`${fileName} has no dead-letter rows.`);
  }
  if (records.length > MAX_RECORDS) {
    throw new DeadLetterParseError(`${fileName} has ${records.length} rows; the limit is ${MAX_RECORDS}.`);
  }
  const seen = new Map<string, string>();
  records.forEach((record, index) => {
    const where = looksJson ? `item ${index}` : `row ${index + 2}`;
    const first = seen.get(record.id);
    if (first) {
      throw new DeadLetterParseError(`${fileName}, ${where}: id "${record.id}" already appears at ${first}.`);
    }
    seen.set(record.id, where);
  });
  return records;
}

function parseJson(fileName: string, text: string): DeadLetterRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new DeadLetterParseError(`${fileName} is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}.`);
  }
  // Accept the API envelope ({ success, data: [...] }) as well as a bare array.
  if (isObject(data) && Array.isArray(data.data)) data = data.data;
  if (!Array.isArray(data)) {
    throw new DeadLetterParseError(`${fileName}: expected a JSON array of events at the top level.`);
  }
  return data.map((item, index) => {
    const where = `${fileName}, item ${index}`;
    if (!isObject(item)) throw new DeadLetterParseError(`${where}: expected an object.`);
    return {
      id: requireText(item, 'id', where),
      type: requireText(item, 'type', where),
      payload: pick(item, 'payload') ?? null,
      retryCount: requireCount(pick(item, 'retryCount'), `${where}, retry_count`),
      lastError: optionalError(pick(item, 'lastError'), `${where}, last_error`),
    };
  });
}

function parseCsv(fileName: string, text: string): DeadLetterRecord[] {
  const rows = splitCsv(fileName, text).filter((row) => !(row.length === 1 && row[0].trim() === ''));
  if (rows.length === 0) throw new DeadLetterParseError(`${fileName} is empty.`);
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const missing = CSV_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new DeadLetterParseError(
      `${fileName}, row 1: missing column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}. Expected ${CSV_COLUMNS.join(',')}.`,
    );
  }
  const column = (name: (typeof CSV_COLUMNS)[number]) => header.indexOf(name);
  return rows.slice(1).map((row, index) => {
    const where = `${fileName}, row ${index + 2}`;
    if (row.length !== header.length) {
      throw new DeadLetterParseError(`${where}: expected ${header.length} fields, found ${row.length}.`);
    }
    const id = row[column('id')].trim();
    const type = row[column('type')].trim();
    if (!id) throw new DeadLetterParseError(`${where}, id: expected a non-empty value.`);
    if (!type) throw new DeadLetterParseError(`${where}, type: expected a non-empty value.`);
    const rawCount = row[column('retry_count')].trim();
    if (!/^\d+$/.test(rawCount)) {
      throw new DeadLetterParseError(`${where}, retry_count: expected a whole number of 0 or more, found "${rawCount}".`);
    }
    return {
      id,
      type,
      payload: readPayload(row[column('payload')]),
      retryCount: Number(rawCount),
      lastError: row[column('last_error')].trim(),
    };
  });
}

/** RFC 4180 style: commas, double-quoted fields, "" as an escaped quote, CRLF or LF rows. */
function splitCsv(fileName: string, text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let quoteStartLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      quoteStartLine = line;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line += 1;
    } else {
      field += ch;
    }
  }
  if (quoted) {
    throw new DeadLetterParseError(`${fileName}, line ${quoteStartLine}: a quoted field is never closed.`);
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(item: Record<string, unknown>, field: keyof typeof FIELD_ALIASES): unknown {
  for (const name of FIELD_ALIASES[field]) {
    if (name in item) return item[name];
  }
  return undefined;
}

function requireText(item: Record<string, unknown>, field: 'id' | 'type', where: string): string {
  const value = pick(item, field);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DeadLetterParseError(`${where}, ${FIELD_ALIASES[field].join(' or ')}: expected a non-empty string.`);
  }
  return value.trim();
}

function requireCount(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DeadLetterParseError(`${where}: expected a whole number of 0 or more, found ${JSON.stringify(value) ?? 'nothing'}.`);
  }
  return value;
}

function optionalError(value: unknown, where: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new DeadLetterParseError(`${where}: expected text or null, found ${typeof value}.`);
  }
  return value.trim();
}

export function fromOutboxEvents(events: OutboxEvent[]): DeadLetterRecord[] {
  return events
    .filter((event) => event.status === 'DEAD_LETTER')
    .map((event) => ({
      id: event.id,
      type: event.eventType,
      payload: event.payload,
      retryCount: event.retryCount,
      lastError: (event.errorMessage ?? '').trim(),
    }));
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIXED_ID = /\b[a-z]+_[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/g;
// Hex ids mix digits and letters; an all-digit run is a number and is handled below.
const LONG_HEX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
// Measured amounts (durations, sizes, percentages) and long numbers vary between
// otherwise identical failures. Short bare numbers such as an HTTP status are kept,
// so a 503 and a 504 stay in separate groups.
const MEASURED = /\d+(?:\.\d+)?(?=\s?(?:ms|s|sec|seconds|kb|mb|bytes|%)(?![a-z]))/gi;
const LONG_NUMBER = /\b\d{4,}(?:\.\d+)?\b/g;

/** Replaces identifiers and measured values so "Timeout after 3012 ms" and "Timeout after 2999 ms" share a group. */
export function normalizeError(message: string): string {
  const text = message.trim();
  if (text === '') return NO_ERROR_KEY;
  return text
    .replace(UUID, '<id>')
    .replace(PREFIXED_ID, '<id>')
    .replace(LONG_HEX, '<id>')
    .replace(MEASURED, '<n>')
    .replace(LONG_NUMBER, '<n>')
    .replace(/\s+/g, ' ');
}

export function groupByError(records: DeadLetterRecord[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const record of records) {
    const key = normalizeError(record.lastError);
    let group = groups.get(key);
    if (!group) {
      group = { key, sample: record.lastError, records: [], types: [], minAttempts: record.retryCount, maxAttempts: record.retryCount };
      groups.set(key, group);
    }
    group.records.push(record);
    if (!group.types.includes(record.type)) group.types.push(record.type);
    group.minAttempts = Math.min(group.minAttempts, record.retryCount);
    group.maxAttempts = Math.max(group.maxAttempts, record.retryCount);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, types: [...group.types].sort() }))
    .sort((a, b) => b.records.length - a.records.length || a.key.localeCompare(b.key));
}

/** A JSON array of event ids, in the order the groups list them. */
export function toReplayJson(records: DeadLetterRecord[]): string {
  return `${JSON.stringify(records.map((record) => record.id), null, 2)}\n`;
}

/** The same columns the importer reads, so the list can be loaded again or handed to a script. */
export function toReplayCsv(records: DeadLetterRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const record of records) {
    const payload = record.payload === null ? '' : typeof record.payload === 'string' ? record.payload : JSON.stringify(record.payload);
    lines.push([record.id, record.type, payload, String(record.retryCount), record.lastError].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ReplayOutcome {
  retried: string[];
  skipped: string[];
}

/** A failed batch, carrying what the earlier batches already replayed. */
export class ReplayBatchError extends Error {
  constructor(
    message: string,
    readonly partial: ReplayOutcome,
  ) {
    super(message);
    this.name = 'ReplayBatchError';
  }
}

/**
 * Sends ids to `send` in batches no larger than `batchSize`, one batch at a time, and
 * merges the results. Duplicate ids are sent once. A failed batch stops the run with a
 * ReplayBatchError, so the caller can report what was already replayed.
 */
export async function replayInBatches(
  ids: string[],
  batchSize: number,
  send: (batch: string[]) => Promise<ReplayOutcome>,
): Promise<ReplayOutcome> {
  const unique = [...new Set(ids)];
  const done: ReplayOutcome = { retried: [], skipped: [] };
  for (let start = 0; start < unique.length; start += batchSize) {
    try {
      const result = await send(unique.slice(start, start + batchSize));
      done.retried.push(...result.retried);
      done.skipped.push(...result.skipped);
    } catch (err) {
      throw new ReplayBatchError(err instanceof Error ? err.message : 'the request failed', done);
    }
  }
  return done;
}
