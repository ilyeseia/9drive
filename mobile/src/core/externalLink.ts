import { Linking } from 'react-native';

/**
 * The ONLY place in the app allowed to open an external URL (enforced by `architecture-rules.test.ts`).
 *
 * It is used for one purpose: sending the user to a storage provider's sign-in page. The URL always comes from the
 * authenticated 9Drive server (never from user input, links or deep links) and is still validated: HTTPS only, a
 * real host name (no IP literals, no localhost), no embedded credentials and a sane length.
 */
export class ExternalUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalUrlError';
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function validateExternalUrl(raw: string): URL {
  if (raw.length > 2048) throw new ExternalUrlError('The sign-in address is too long.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExternalUrlError('The sign-in address is not valid.');
  }
  if (url.protocol !== 'https:') throw new ExternalUrlError('The sign-in address must use HTTPS.');
  if (url.username || url.password) throw new ExternalUrlError('The sign-in address must not contain credentials.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || IPV4.test(host) || host.startsWith('[')) {
    throw new ExternalUrlError('The sign-in address must be a public web address.');
  }
  return url;
}

/** Opens a provider sign-in page in the system browser after validating the address. */
export async function openProviderSignIn(raw: string): Promise<void> {
  const url = validateExternalUrl(raw);
  await Linking.openURL(url.toString());
}
