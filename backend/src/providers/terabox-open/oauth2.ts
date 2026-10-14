/**
 * OAuth client registration for `terabox_open` — provider-contract §8.
 *
 * TeraBox is connected through device-code mode (QR scan), not a redirect flow:
 * the authorization-code web flow documents no `redirect_uri` and no `state`.
 * `authorizationUrl`/`tokenUrl` are therefore informational; the generic redirect
 * connect route rejects this provider (catalog `connectMode: 'device_code'`).
 * Token refresh uses the signed, single-use-refresh-token endpoint through the
 * `refresh` hook, which `buildContext()` reaches via `refreshAccessToken()`.
 */

import { registerOAuth2Client, type OAuth2ClientConfig } from '../oauth2.js';
import { refreshTeraBoxTokens } from './auth.js';
import { ProviderError } from '../errors.js';

export const TERABOX_OPEN_AUTHORIZATION_URL = 'https://www.terabox.com/wap/outside/login';
export const TERABOX_OPEN_TOKEN_URL = 'https://www.terabox.com/oauth/gettoken';

export const TERABOX_OPEN_OAUTH_CLIENT: OAuth2ClientConfig = {
  id: 'terabox_open',
  authorizationUrl: TERABOX_OPEN_AUTHORIZATION_URL,
  tokenUrl: TERABOX_OPEN_TOKEN_URL,
  scopes: [],
  refresh: (options) => {
    if (!options.refreshToken) throw new ProviderError('ERR_AUTH_EXPIRED', 'A refresh token is required');
    return refreshTeraBoxTokens({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: options.refreshToken,
      signal: options.signal,
    });
  },
};

export function registerTeraBoxOpenOAuth2Client(): void {
  registerOAuth2Client(TERABOX_OPEN_OAUTH_CLIENT);
}

registerTeraBoxOpenOAuth2Client();
