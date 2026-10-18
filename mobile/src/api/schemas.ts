/**
 * Shared response primitives. Per-feature schemas live next to their endpoint modules.
 *
 * Contracts are copied from the backend source (see docs/mobile/00-audit-and-plan.md), and are deliberately
 * tolerant of extra fields (`z.object` strips them) but strict about the fields the app relies on.
 */

import { z } from 'zod';

/** The backend serialises BigInt as a decimal string. */
export const bytesString = z.string().regex(/^\d{1,19}$/, 'expected a decimal byte count');

/** Converts a validated byte string to a number. Values above 2^53 (~9 PB) are clamped, never wrapped. */
export function bytesToNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(n, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

export const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'expected an ISO date');

export const okStatus = z.object({ status: z.string() }).passthrough();
