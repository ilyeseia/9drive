/**
 * Public barrel for the provider layer — see
 * docs/architecture/contracts/provider-contract.md §6.
 *
 * Adapters register here via side-effect import (`registry.register(...)`).
 * Modules must only obtain providers through `registry`.
 */

export * from './types.js';
export * from './errors.js';
export * from './catalog.js';
export * from './registry.js';
export * from './fake.js';
export * from './oauth2.js';
export * from './context.js';
export * from './health.js';
export * from './routing.js';

export { s3Provider, registerS3Provider } from './s3/index.js';
export { dropboxProvider, registerDropboxProvider } from './dropbox/index.js';
export { onedriveProvider, registerOnedriveProvider } from './onedrive/index.js';
export { pcloudProvider, registerPcloudProvider } from './pcloud/index.js';
export { googleDriveProvider, registerGoogleDriveProvider } from './google-drive/index.js';
export { teraboxProvider, registerTeraBoxProvider } from './terabox/index.js';

import { registerS3Provider } from './s3/index.js';
import { registerDropboxProvider } from './dropbox/index.js';
import { registerOnedriveProvider } from './onedrive/index.js';
import { registerPcloudProvider } from './pcloud/index.js';
import { registerGoogleDriveProvider } from './google-drive/index.js';
import { registerTeraBoxProvider } from './terabox/index.js';

registerS3Provider();
registerDropboxProvider();
registerOnedriveProvider();
registerPcloudProvider();
registerGoogleDriveProvider();
registerTeraBoxProvider();
