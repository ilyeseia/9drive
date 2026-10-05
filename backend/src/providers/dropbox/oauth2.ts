/**
 * Dropbox OAuth2 client registration — provider-contract §8 and §11.
 * `buildAuthorizationUrl` / `exchangeCode` / `refreshAccessToken` read this config.
 * `token_access_type=offline` makes Dropbox issue a long-lived refresh token.
 * Scopes are the granular Dropbox scopes covering every declared capability.
 */

import { registerOAuth2Client, type OAuth2ClientConfig } from '../oauth2.js';

export const DROPBOX_AUTHORIZATION_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export const DROPBOX_SCOPES: string[] = [
  'account_info.read',
  'files.metadata.read',
  'files.metadata.write',
  'files.content.read',
  'files.content.write',
  'sharing.read',
  'sharing.write',
];

export const DROPBOX_OAUTH_CLIENT: OAuth2ClientConfig = {
  id: 'dropbox',
  authorizationUrl: DROPBOX_AUTHORIZATION_URL,
  tokenUrl: DROPBOX_TOKEN_URL,
  scopes: [...DROPBOX_SCOPES],
  authorizationParams: {
    token_access_type: 'offline',
  },
};

export function registerDropboxOAuth2Client(): void {
  registerOAuth2Client(DROPBOX_OAUTH_CLIENT);
}

registerDropboxOAuth2Client();
