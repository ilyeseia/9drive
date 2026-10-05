/**
 * OneDrive (Microsoft identity platform) OAuth2 client registration —
 * provider-contract §8 and §11. `buildAuthorizationUrl` / `exchangeCode` /
 * `refreshAccessToken` read this config. `offline_access` is required for the
 * refresh token; scopes cover every declared capability (files read/write,
 * profile for getAccountInfo, sharing via Files.ReadWrite).
 */

import { registerOAuth2Client, type OAuth2ClientConfig } from '../oauth2.js';

export const ONEDRIVE_AUTHORIZATION_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const ONEDRIVE_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

export const ONEDRIVE_SCOPES: string[] = [
  'offline_access',
  'User.Read',
  'Files.ReadWrite',
  'Files.ReadWrite.All',
];

export const ONEDRIVE_OAUTH_CLIENT: OAuth2ClientConfig = {
  id: 'onedrive',
  authorizationUrl: ONEDRIVE_AUTHORIZATION_URL,
  tokenUrl: ONEDRIVE_TOKEN_URL,
  scopes: [...ONEDRIVE_SCOPES],
};

export function registerOnedriveOAuth2Client(): void {
  registerOAuth2Client(ONEDRIVE_OAUTH_CLIENT);
}

registerOnedriveOAuth2Client();
