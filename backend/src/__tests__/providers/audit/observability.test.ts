import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/prisma.js';
import { requestIdMiddleware } from '../../../middleware/request-id.middleware.js';
import { buildProviderDiagnostics } from '../../../modules/providers/diagnostics.js';
import { listProviderAccountViews } from '../../../modules/providers/account-service.js';
import { createLogger } from '../../../queues/logger.js';
import { currentRequestId } from '../../../utils/request-context.js';
import { encryptText } from '../../../utils/crypto.js';
import { createTestUser, pingDb } from '../platform/helpers.js';

function runMiddleware(inbound?: string): { id: string | undefined; header: string | undefined } {
  let header: string | undefined;
  let id: string | undefined;
  const req = { header: (name: string) => (name.toLowerCase() === 'x-request-id' ? inbound : undefined) } as unknown as Request;
  const res = { setHeader: (_name: string, value: string) => { header = value; } } as unknown as Response;
  requestIdMiddleware(req, res, (() => { id = currentRequestId(); }) as NextFunction);
  return { id, header };
}

describe('correlation ids', () => {
  it('honours a well-formed inbound id and exposes it to the log context', () => {
    const { id, header } = runMiddleware('client-req-12345');
    expect(id).toBe('client-req-12345');
    expect(header).toBe('client-req-12345');
  });

  it('replaces malformed or oversized ids (no log injection)', () => {
    for (const bad of ['short', 'has spaces and \n newline', 'x'.repeat(200), '<script>alert(1)</script>']) {
      const { id, header } = runMiddleware(bad);
      expect(id).toBeDefined();
      expect(id).not.toBe(bad);
      expect(header).toBe(id);
    }
  });

  it('adds the request id to structured log lines', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      let inside = '';
      const req = { header: () => 'trace-abcdef12' } as unknown as Request;
      const res = { setHeader: () => undefined } as unknown as Response;
      requestIdMiddleware(req, res, (() => {
        createLogger({ component: 'test' }).info('hello');
        inside = currentRequestId() ?? '';
      }) as NextFunction);
      expect(inside).toBe('trace-abcdef12');
    } finally {
      console.log = original;
    }
    expect(lines.some((line) => line.includes('"requestId":"trace-abcdef12"'))).toBe(true);
  });
});

describe('account views, pagination and diagnostics (real DB)', () => {
  let dbOk = false;
  let userId = '';
  let otherUserId = '';
  const secret = 'super-secret-token-value';

  beforeAll(async () => {
    dbOk = await pingDb();
    if (!dbOk) return;
    userId = (await createTestUser('obs')).id;
    otherUserId = (await createTestUser('obs-other')).id;
    const base = Date.now();
    const make = (uid: string, i: number, status: string, lastError: string | null = null) =>
      prisma.connectedAccount.create({
        data: {
          userId: uid,
          provider: 'dropbox',
          providerAccountId: `obs-${i}-${randomUUID().slice(0, 4)}`,
          email: `private-${i}@example.test`,
          scopes: [],
          status,
          lastError,
          accessTokenEncrypted: encryptText(secret),
          refreshTokenEncrypted: encryptText(secret),
          createdAt: new Date(base - i * 1000),
        },
      });
    await make(userId, 1, 'connected');
    await make(userId, 2, 'connected', 'Token endpoint is temporarily unavailable');
    await make(userId, 3, 'unauthorized', 'invalid_grant');
    await make(userId, 4, 'disconnected');
    await make(otherUserId, 5, 'connected');
  });

  afterAll(async () => {
    if (!dbOk) return;
    await prisma.connectedAccount.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }).catch(() => undefined);
  });

  it('exposes lifecycle fields in the account view and pages deterministically', async (ctx) => {
    if (!dbOk) ctx.skip();
    const all = await listProviderAccountViews(userId);
    expect(all).toHaveLength(3); // disconnected is hidden
    const reauth = all.find((a) => a.status === 'unauthorized')!;
    expect(reauth.lifecycle).toBe('reauthorization_required');
    expect(reauth.needsReauthorization).toBe(true);
    expect(reauth.routable).toBe(false);
    const transient = all.find((a) => a.lastError?.includes('temporarily'))!;
    expect(transient.lifecycle).toBe('connected');
    expect(transient.hasTransientIssue).toBe(true);
    expect(transient.needsReauthorization).toBe(false);

    const first = await listProviderAccountViews(userId, { limit: 2, offset: 0 });
    const second = await listProviderAccountViews(userId, { limit: 2, offset: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((a) => a.id)).size).toBe(3);
  });

  it('diagnostic report is tenant-scoped and leaks no credentials or personal data', async (ctx) => {
    if (!dbOk) ctx.skip();
    const report = await buildProviderDiagnostics(userId);
    expect(report.totalAccounts).toBe(4); // includes disconnected, excludes pending, excludes other tenants
    expect(report.truncated).toBe(false);
    expect(report.byProvider.dropbox).toMatchObject({ connected: 2, reauthorization_required: 1, disconnected: 1 });
    const blocked = report.accounts.find((a) => a.status === 'unauthorized')!;
    expect(blocked.routable).toBe(false);
    expect(blocked.routingBlockedReason).toBe('reauthorization required');
    expect(blocked.hasRefreshToken).toBe(true);
    const text = JSON.stringify(report);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('private-');
    expect(text).not.toContain('@example.test');
    expect(report.accounts.every((a) => a.id && a.provider === 'dropbox')).toBe(true);
  });
});
