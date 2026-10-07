/**
 * Static provider catalog — see docs/architecture/contracts/provider-contract.md §2 and §7.
 *
 * `GET /providers/catalog` returns `listCatalog()` verbatim. Every id from §2 must
 * appear here with an accurate status; non-SUPPORTED entries must explain why.
 */

import type { AuthMode, Capability, ProviderId } from './types.js';
import { ALL_CAPABILITIES } from './types.js';

export type ProviderCatalogStatus = 'SUPPORTED' | 'PLANNED' | 'RESEARCH_REQUIRED' | 'UNSUPPORTED' | 'VIA_S3';

export interface ProviderCatalogEntry {
  id: ProviderId;
  displayName: string;
  status: ProviderCatalogStatus;
  authMode: AuthMode;
  capabilities: Capability[];
  docsUrl?: string;
  notes?: string;
  s3Preset?: { endpoint: string; forcePathStyle: boolean; region: string };
}

const S3_CAPABILITIES: Capability[] = [
  'authenticate',
  'getAccountInfo',
  'getQuota',
  'upload',
  'uploadResumable',
  'download',
  'downloadRange',
  'list',
  'getMetadata',
  'createFolder',
  'rename',
  'move',
  'copy',
  'delete',
  'createShare',
  'healthCheck',
];

const ALL: Capability[] = [...ALL_CAPABILITIES];

const PCLOUD_CAPABILITIES: Capability[] = ALL.filter((capability) => capability !== 'uploadResumable');

/** Cookie-session TeraBox exposes no share endpoints and no resumable upload ids. */
const TERABOX_CAPABILITIES: Capability[] = ALL.filter(
  (capability) => capability !== 'uploadResumable' && capability !== 'createShare' && capability !== 'revokeShare',
);

const RAW_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'google_drive',
    displayName: 'Google Drive',
    status: 'SUPPORTED',
    authMode: 'oauth2',
    capabilities: ALL,
    docsUrl: 'https://developers.google.com/drive/api/v3/overview',
    notes: 'Root folder "9drive" per account; Google Docs types are export-converted on download; public sharing is opt-in and reader-only.',
  },
  {
    id: 's3',
    displayName: 'S3-compatible (AWS, MinIO, R2, B2, Wasabi, IDrive e2, Internxt, …)',
    status: 'SUPPORTED',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html',
    notes: 'Object key layout prefix/userId/fileId/fileName; quota aggregated via ListObjectsV2; custom endpoints must pass the SSRF gate.',
  },
  {
    id: 'dropbox',
    displayName: 'Dropbox',
    status: 'SUPPORTED',
    authMode: 'oauth2',
    capabilities: ALL,
    docsUrl: 'https://dropbox.github.io/dropbox-api-v2-docs/',
    notes: 'Upload sessions used above the 150 MB simple-upload limit; list uses list_folder cursor pagination.',
  },
  {
    id: 'onedrive',
    displayName: 'OneDrive',
    status: 'SUPPORTED',
    authMode: 'oauth2',
    capabilities: ALL,
    docsUrl: 'https://learn.microsoft.com/graph/api/resources/onedrive',
    notes: 'Upload sessions used above the 4 MB simple-upload limit; quota from /me/drive?$select=quota; shares via createLink.',
  },
  {
    id: 'pcloud',
    displayName: 'pCloud',
    status: 'SUPPORTED',
    authMode: 'oauth2',
    capabilities: PCLOUD_CAPABILITIES,
    docsUrl: 'https://docs.pcloud.com/',
    notes: 'Access tokens do not expire; quota from userinfo (quota, usedquota); uploads use PUT uploadfile (no resumable sessions); listfolder has no server-side paging. EU accounts return a hostname that must be stored with the account.',
  },
  {
    id: 'box',
    displayName: 'Box',
    status: 'PLANNED',
    authMode: 'oauth2',
    capabilities: [],
    docsUrl: 'https://developer.box.com/',
    notes: 'Official Box API (OAuth2 + Files) is available; adapter not implemented yet.',
  },
  {
    id: 'yandex_disk',
    displayName: 'Yandex Disk',
    status: 'PLANNED',
    authMode: 'oauth2',
    capabilities: [],
    docsUrl: 'https://yandex.com/dev/disk/',
    notes: 'Official Yandex Disk REST API (OAuth2) is available; adapter not implemented yet.',
  },
  {
    id: 'koofr',
    displayName: 'Koofr',
    status: 'PLANNED',
    authMode: 'api_key',
    capabilities: [],
    docsUrl: 'https://koofr.net/docs/',
    notes: 'Official Koofr API is available; adapter not implemented yet.',
  },
  {
    id: 'mega',
    displayName: 'MEGA',
    status: 'RESEARCH_REQUIRED',
    authMode: 'api_key',
    capabilities: [],
    notes: 'No official public API; community integrations re-implement MEGA\'s private protocol, which 9Drive does not perform. Research into an official API offering would be required first.',
  },
  {
    id: 'mediafire',
    displayName: 'MediaFire',
    status: 'PLANNED',
    authMode: 'api_key',
    capabilities: [],
    docsUrl: 'https://www.mediafire.com/developers/',
    notes: 'Official MediaFire API is available; adapter not implemented yet.',
  },
  {
    id: 'terabox',
    displayName: 'TeraBox',
    status: 'SUPPORTED',
    authMode: 'api_key',
    capabilities: TERABOX_CAPABILITIES,
    notes:
      'Reverse-engineered web API authenticated with the browser session cookie (paste the ndus value or the whole cookie header); no official self-serve API exists, so endpoints may change without notice. remoteId is the POSIX path (root children report parentId null); uploads stream in 4 MiB chunks, overwrite existing files and are limited to 4 GiB on free accounts; delete uses the shared recycle bin; sharing is not available over the cookie session.',
  },
  {
    id: 'proton_drive',
    displayName: 'Proton Drive',
    status: 'RESEARCH_REQUIRED',
    authMode: 'oauth2',
    capabilities: [],
    notes: 'Drive access is not exposed through a stable public API yet (SDK preview only); research and an official API would be required before an adapter can be written.',
  },
  {
    id: 'icedrive',
    displayName: 'Icedrive',
    status: 'UNSUPPORTED',
    authMode: 'api_key',
    capabilities: [],
    notes: 'No official public API; community integrations require reverse-engineered private endpoints and session extraction, which 9Drive does not perform.',
  },
  {
    id: 'sync',
    displayName: 'Sync.com',
    status: 'UNSUPPORTED',
    authMode: 'api_key',
    capabilities: [],
    notes: 'No official public API and no third-party app access; 9Drive cannot integrate without one.',
  },
  {
    id: 'idrive',
    displayName: 'IDrive (consumer)',
    status: 'UNSUPPORTED',
    authMode: 'api_key',
    capabilities: [],
    notes: 'No official public API for the consumer IDrive product; only the enterprise/e2 S3-compatible offering is integrable.',
  },
  {
    id: 'internxt',
    displayName: 'Internxt',
    status: 'VIA_S3',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://docs.internxt.com/',
    notes: 'Preset for the S3-compatible adapter, not a separate adapter; confirm endpoint and region in your Internxt account.',
    s3Preset: { endpoint: 'https://s3.internxt.com', forcePathStyle: false, region: 'us-east-1' },
  },
  {
    id: 'idrive_e2',
    displayName: 'IDrive e2',
    status: 'VIA_S3',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://www.idrive.com/e2/',
    notes: 'Preset for the S3-compatible adapter; endpoint must match your e2 region (for example s3.us-east-1.idrivee2-aws.com).',
    s3Preset: { endpoint: 'https://s3.us-east-1.idrivee2-aws.com', forcePathStyle: false, region: 'us-east-1' },
  },
  {
    id: 'backblaze_b2',
    displayName: 'Backblaze B2',
    status: 'VIA_S3',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://www.backblaze.com/cloud-storage/s3-compatible-api',
    notes: 'Preset for the S3-compatible adapter; endpoint must be your bucket endpoint of the form s3.<region>.backblazeb2.com.',
    s3Preset: { endpoint: 'https://s3.us-west-001.backblazeb2.com', forcePathStyle: false, region: 'us-west-001' },
  },
  {
    id: 'cloudflare_r2',
    displayName: 'Cloudflare R2',
    status: 'VIA_S3',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://developers.cloudflare.com/r2/api/s3/tokens/',
    notes: 'Preset for the S3-compatible adapter; endpoint must be https://<account_id>.r2.cloudflarestorage.com and region is always "auto".',
    s3Preset: { endpoint: 'https://<account_id>.r2.cloudflarestorage.com', forcePathStyle: false, region: 'auto' },
  },
  {
    id: 'minio',
    displayName: 'MinIO',
    status: 'VIA_S3',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://min.io/docs/minio/linux/developers/s3/',
    notes: 'Preset for the S3-compatible adapter; path-style addressing is the MinIO default and the endpoint must pass the SSRF gate.',
    s3Preset: { endpoint: 'http://127.0.0.1:9000', forcePathStyle: true, region: 'us-east-1' },
  },
  {
    id: 'wasabi',
    displayName: 'Wasabi',
    status: 'VIA_S3',
    authMode: 'access_key',
    capabilities: S3_CAPABILITIES,
    docsUrl: 'https://docs.wasabi.com/',
    notes: 'Preset for the S3-compatible adapter; endpoint must match the storage region chosen when creating the access key.',
    s3Preset: { endpoint: 'https://s3.wasabisys.com', forcePathStyle: false, region: 'us-east-1' },
  },
];

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = Object.freeze(
  RAW_CATALOG.map((entry) => Object.freeze({ ...entry, capabilities: [...entry.capabilities] })),
);

const CATALOG_BY_ID: ReadonlyMap<ProviderId, ProviderCatalogEntry> = new Map(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry]),
);

function getEntry(id: ProviderId): ProviderCatalogEntry | null {
  return CATALOG_BY_ID.get(id) ?? null;
}

function requireEntry(id: ProviderId): ProviderCatalogEntry {
  const entry = getEntry(id);
  if (!entry) throw new Error(`unknown provider '${id}'`);
  return entry;
}

function listEntries(): ProviderCatalogEntry[] {
  return [...PROVIDER_CATALOG];
}

function hasEntry(id: ProviderId): boolean {
  return CATALOG_BY_ID.has(id);
}

function supportedEntries(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((entry) => entry.status === 'SUPPORTED').map((entry) => ({ ...entry }));
}

export const catalog = {
  get: getEntry,
  require: requireEntry,
  list: listEntries,
  has: hasEntry,
  supported: supportedEntries,
};

export function getCatalogEntry(id: ProviderId): ProviderCatalogEntry | null {
  return getEntry(id);
}

export function isProviderSupported(id: ProviderId): boolean {
  const entry = getEntry(id);
  return entry !== null && entry.status === 'SUPPORTED';
}
