/**
 * pCloud OAuth2 client registration — provider-contract §8 and §11.
 * The code flow starts at https://my.pcloud.com/oauth2/authorize and the code is
 * exchanged at https://api.pcloud.com/oauth2_token (note: `oauth2_token`, not
 * `oauth2/token`). The authorize page takes no `scope` parameter and pCloud
 * grants full account access, so `scopes` stays empty and the shared builder
 * omits `scope`. pCloud issues no refresh token and access tokens do not
 * expire (`expiresAt` is null), so renewal is never attempted.
 *
 * EU caveat: the authorize redirect carries `hostname` (api.pcloud.com or
 * eapi.pcloud.com) and pCloud requires subsequent calls on that host. Persist
 * it to account config as `apiBaseUrl` / `tokenUrl` (see the provider doc).
 */

import { registerOAuth2Client, type OAuth2ClientConfig } from '../oauth2.js';

export const PCLOUD_AUTHORIZATION_URL = 'https://my.pcloud.com/oauth2/authorize';
export const PCLOUD_TOKEN_URL = 'https://api.pcloud.com/oauth2_token';

export const PCLOUD_SCOPES: string[] = [];

export const PCLOUD_OAUTH_CLIENT: OAuth2ClientConfig = {
  id: 'pcloud',
  authorizationUrl: PCLOUD_AUTHORIZATION_URL,
  tokenUrl: PCLOUD_TOKEN_URL,
  scopes: [...PCLOUD_SCOPES],
};

export function registerPcloudOAuth2Client(): void {
  registerOAuth2Client(PCLOUD_OAUTH_CLIENT);
}

registerPcloudOAuth2Client();
