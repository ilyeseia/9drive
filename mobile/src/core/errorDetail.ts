import { ApiError } from '../api/errors';

const MAX_DETAIL = 160;

/**
 * Short technical description of a failure for support: error kind, HTTP status and the server's error CODE (a fixed
 * identifier). The server's free-text message is deliberately NOT included (the UI never shows raw server text).
 * Exceptions that did not come from the API are described by name and first message line, with local file paths
 * removed and the text truncated.
 */
export function describeErrorDetail(error: unknown): string {
  const scrub = (text: string) =>
    text
      .split('\n')[0]!
      .replace(/(file|content):\/\/\S+/gi, '<file>')
      .replace(/\b[A-Za-z]:\\\S+/g, '<file>')
      .slice(0, MAX_DETAIL);
  if (ApiError.is(error)) {
    const parts = [error.kind, error.status !== null ? `HTTP ${error.status}` : null, error.code];
    return parts.filter((part): part is string => Boolean(part)).join(' · ');
  }
  if (error instanceof Error) return scrub(`${error.name}: ${error.message}`);
  return scrub(String(error));
}
