import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OutboxDatabase } from '../src/db/database.js';
import { OutboxService } from '../src/services/outbox.service.js';
import { createApp } from '../src/app.js';
import { DEFAULT_RETRY_POLICY, ValidationError, parseStoredRetryPolicy, retryPolicyFromEnv } from '../../shared/outbox-logic.js';

const BUILT_IN = { maxAttempts: 3, backoffBaseMs: 2000, backoffMaxMs: 60000 };

describe('retry policy from the environment', () => {
  it('uses the built-in policy when no variable is set or a variable is empty', () => {
    expect(retryPolicyFromEnv({})).toEqual(BUILT_IN);
    expect(retryPolicyFromEnv({ RETRY_MAX_ATTEMPTS: '', RETRY_BACKOFF_BASE_MS: '  ' })).toEqual(BUILT_IN);
  });

  it('reads each variable on its own and keeps the rest at the built-in values', () => {
    expect(retryPolicyFromEnv({ RETRY_MAX_ATTEMPTS: '5' })).toEqual({ ...BUILT_IN, maxAttempts: 5 });
    expect(retryPolicyFromEnv({ RETRY_BACKOFF_BASE_MS: ' 500 ', RETRY_BACKOFF_MAX_MS: '8000' })).toEqual({
      maxAttempts: 3,
      backoffBaseMs: 500,
      backoffMaxMs: 8000,
    });
  });

  it.each([
    [{ RETRY_MAX_ATTEMPTS: '0' }, 'RETRY_MAX_ATTEMPTS must be an integer between 1 and 10, got "0"'],
    [{ RETRY_MAX_ATTEMPTS: '11' }, 'RETRY_MAX_ATTEMPTS must be an integer between 1 and 10'],
    [{ RETRY_MAX_ATTEMPTS: '3.5' }, 'RETRY_MAX_ATTEMPTS must be an integer'],
    [{ RETRY_BACKOFF_BASE_MS: '2s' }, 'RETRY_BACKOFF_BASE_MS must be an integer between 100 and 60000, got "2s"'],
    [{ RETRY_BACKOFF_MAX_MS: '-1' }, 'RETRY_BACKOFF_MAX_MS must be an integer between 100 and 600000'],
    [{ RETRY_BACKOFF_MAX_MS: '1000' }, 'RETRY_BACKOFF_MAX_MS (1000) must be at least RETRY_BACKOFF_BASE_MS (2000)'],
  ])('rejects %j', (env, message) => {
    expect(() => retryPolicyFromEnv(env)).toThrow(ValidationError);
    expect(() => retryPolicyFromEnv(env)).toThrow(message);
  });
});

describe('stored retry policy', () => {
  it('reads a complete, valid policy', () => {
    expect(parseStoredRetryPolicy('{"maxAttempts":4,"backoffBaseMs":500,"backoffMaxMs":9000}')).toEqual({
      maxAttempts: 4,
      backoffBaseMs: 500,
      backoffMaxMs: 9000,
    });
  });

  it.each([
    ['not json'],
    ['null'],
    ['{"maxAttempts":4}'],
    ['{"maxAttempts":40,"backoffBaseMs":500,"backoffMaxMs":9000}'],
    ['{"maxAttempts":4,"backoffBaseMs":5000,"backoffMaxMs":1000}'],
    ['{"maxAttempts":4,"backoffBaseMs":500,"backoffMaxMs":9000,"jitter":true}'],
  ])('ignores %s', (json) => {
    expect(parseStoredRetryPolicy(json)).toBeNull();
  });
});

describe('retry policy kept across restarts', () => {
  let dir: string;
  let dbPath: string;
  const open: OutboxDatabase[] = [];

  const start = (env: Record<string, string | undefined> = {}) => {
    const db = new OutboxDatabase(dbPath);
    open.push(db);
    return new OutboxService(db, false, env);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outboxrelay-policy-'));
    dbPath = path.join(dir, 'outbox.db');
  });

  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts with the built-in policy on a new database', () => {
    expect(start().getRetryPolicy()).toEqual(BUILT_IN);
  });

  it('loads a changed policy after a restart', () => {
    start().setRetryPolicy({ maxAttempts: 6, backoffBaseMs: 250 });
    open.pop()!.close();
    expect(start().getRetryPolicy()).toEqual({ maxAttempts: 6, backoffBaseMs: 250, backoffMaxMs: 60000 });
  });

  it('starts from the environment and lets a saved policy win over it', () => {
    const env = { RETRY_MAX_ATTEMPTS: '5', RETRY_BACKOFF_BASE_MS: '1000' };
    const first = start(env);
    expect(first.getRetryPolicy()).toEqual({ maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 60000 });

    first.setRetryPolicy({ maxAttempts: 2 });
    open.pop()!.close();
    expect(start(env).getRetryPolicy()).toEqual({ maxAttempts: 2, backoffBaseMs: 1000, backoffMaxMs: 60000 });
  });

  it('goes back to the startup policy on reset, and stays there after a restart', () => {
    const env = { RETRY_MAX_ATTEMPTS: '4' };
    const service = start(env);
    service.setRetryPolicy({ maxAttempts: 9, backoffBaseMs: 300 });
    expect(service.resetRetryPolicy()).toEqual({ ...BUILT_IN, maxAttempts: 4 });
    expect(service.getStats().retryPolicy).toEqual({ ...BUILT_IN, maxAttempts: 4 });

    open.pop()!.close();
    expect(start({}).getRetryPolicy()).toEqual(BUILT_IN);
  });

  it('does not save a rejected policy', () => {
    const service = start();
    expect(() => service.setRetryPolicy({ backoffMaxMs: 500 })).toThrow(ValidationError);
    open.pop()!.close();
    expect(start().getRetryPolicy()).toEqual(BUILT_IN);
  });

  it('falls back to the startup policy when the saved row is no longer valid', () => {
    start().setRetryPolicy({ maxAttempts: 5 });
    open.pop()!.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE settings SET value_json = ? WHERE key = 'retry_policy'").run('{"maxAttempts":99,"backoffBaseMs":2000,"backoffMaxMs":60000}');
    raw.close();
    expect(start({ RETRY_MAX_ATTEMPTS: '7' }).getRetryPolicy()).toEqual({ ...BUILT_IN, maxAttempts: 7 });
  });

  it('refuses to start with an invalid environment value', () => {
    expect(() => start({ RETRY_BACKOFF_BASE_MS: 'fast' })).toThrow('RETRY_BACKOFF_BASE_MS must be an integer');
  });
});

describe('DELETE /api/outbox/retry-policy', () => {
  let db: OutboxDatabase;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(() => {
    db = new OutboxDatabase(':memory:');
    app = createApp(new OutboxService(db, false, { RETRY_BACKOFF_MAX_MS: '30000' })).app;
  });

  afterEach(() => {
    db.close();
  });

  it('restores the startup policy and reports it in stats', async () => {
    await request(app).post('/api/outbox/retry-policy').send({ maxAttempts: 8 }).expect(200);
    const res = await request(app).delete('/api/outbox/retry-policy');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ...DEFAULT_RETRY_POLICY, backoffMaxMs: 30000 } });
    expect((await request(app).get('/api/outbox/retry-policy')).body.data).toEqual(res.body.data);
    expect((await request(app).get('/api/stats')).body.data.retryPolicy).toEqual(res.body.data);
    expect(db.getSavedRetryPolicy()).toBeNull();
  });

  it('is safe to call when nothing is saved', async () => {
    const res = await request(app).delete('/api/outbox/retry-policy');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ...DEFAULT_RETRY_POLICY, backoffMaxMs: 30000 });
  });
});
