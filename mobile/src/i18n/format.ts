/**
 * Locale-aware formatting plus bidi helpers.
 *
 * File names are untrusted text in unknown scripts. Dropped into an Arabic sentence they can reorder the
 * surrounding punctuation or numbers; wrapping them in a Unicode isolate keeps each piece in its own
 * direction. Sizes such as "5.2 GB" are always laid out left-to-right so the number stays beside its unit.
 */

import type { Locale } from './messages';

const LRI = '⁦'; // left-to-right isolate
const FSI = '⁨'; // first-strong isolate
const PDI = '⁩'; // pop directional isolate

/** Wraps arbitrary text (a file name, an e-mail) so it cannot disturb the direction of the text around it. */
export function isolate(text: string): string {
  // Strip any isolate/override controls already inside: they could close our isolate early.
  const cleaned = text.replace(/[‪-‮⁦-⁩]/g, '');
  return `${FSI}${cleaned}${PDI}`;
}

/** Forces a short token (a number with a unit) to render left-to-right inside RTL text. */
export function ltr(text: string): string {
  return `${LRI}${text}${PDI}`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
  return ltr(`${number} ${UNITS[unit]}`);
}

export function formatPercent(fraction: number, locale: Locale): string {
  if (!Number.isFinite(fraction)) return '—';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(Math.min(Math.max(fraction, 0), 1));
}

export function formatDate(iso: string, locale: Locale, withTime = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}
