/**
 * Google Drive OAuth2 client registration — provider-contract §8 and §11.
 * `buildAuthorizationUrl` / `exchangeCode` / `refreshAccessToken` read this config;
 * scopes match backend/src/scripts/seed-google-config.ts so the provider-neutral
 * connect flow keeps working next to the legacy Google-only routes.
 */

import { registerOAuth2Client, type OAuth2ClientConfig } from '../oauth2.js';

export const GOOGLE_DRIVE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_DRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_DRIVE_SCOPES: string[] = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export const GOOGLE_DRIVE_OAUTH_CLIENT: OAuth2ClientConfig = {
  id: 'google_drive',
  authorizationUrl: GOOGLE_DRIVE_AUTHORIZATION_URL,
  tokenUrl: GOOGLE_DRIVE_TOKEN_URL,
  scopes: [...GOOGLE_DRIVE_SCOPES],
  authorizationParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
};

export function registerGoogleDriveOAuth2Client(): void {
  registerOAuth2Client(GOOGLE_DRIVE_OAUTH_CLIENT);
}

registerGoogleDriveOAuth2Client();
