import { z } from 'zod';
import type { ApiClient } from '../client';

/** Contract: backend/src/modules/auth/auth.routes.ts. */
export const userSchema = z.object({ id: z.string().min(1), name: z.string(), email: z.string() });
export type User = z.infer<typeof userSchema>;

export const authResponseSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), user: userSchema });
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const refreshResponseSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) });
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const meResponseSchema = z.object({ user: userSchema.extend({ status: z.string().optional() }) });

export const authApi = {
  login: (client: ApiClient, email: string, password: string, signal?: AbortSignal) =>
    client.request({
      method: 'POST',
      path: '/auth/login',
      body: { email: email.trim(), password },
      auth: false,
      schema: authResponseSchema,
      signal,
    }),

  register: (client: ApiClient, name: string, email: string, password: string, signal?: AbortSignal) =>
    client.request({
      method: 'POST',
      path: '/auth/register',
      body: { name: name.trim(), email: email.trim(), password },
      auth: false,
      schema: authResponseSchema,
      signal,
    }),

  refresh: (client: ApiClient, refreshToken: string, signal?: AbortSignal) =>
    client.request({ method: 'POST', path: '/auth/refresh', body: { refreshToken }, auth: false, schema: refreshResponseSchema, signal }),

  me: (client: ApiClient, signal?: AbortSignal) => client.request({ path: '/auth/me', schema: meResponseSchema, signal }),

  /** Best effort: the caller clears local state regardless of the outcome. */
  logout: (client: ApiClient, signal?: AbortSignal) =>
    client.requestVoid({ method: 'POST', path: '/auth/logout', body: {}, signal, timeoutMs: 5_000, retry: { maxRetries: 0 } }),
};
