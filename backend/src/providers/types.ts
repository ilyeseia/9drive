/**
 * Storage-provider abstraction types — normative names from
 * docs/architecture/contracts/provider-contract.md §3 and §4.
 *
 * Renaming or reshaping any exported symbol here is a contract change
 * (see docs/architecture/contracts/README.md §12).
 */

import { ProviderError } from './errors.js';

export type ProviderId = string;

/** Capability vocabulary (contract §3). */
export type Capability =
  | 'authenticate'
  | 'getAccountInfo'
  | 'getQuota'
  | 'upload'
  | 'uploadResumable'
  | 'download'
  | 'downloadRange'
  | 'list'
  | 'getMetadata'
  | 'search'
  | 'createFolder'
  | 'rename'
  | 'move'
  | 'copy'
  | 'delete'
  | 'createShare'
  | 'revokeShare'
  | 'healthCheck';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'authenticate',
  'getAccountInfo',
  'getQuota',
  'upload',
  'uploadResumable',
  'download',
  'downloadRange',
  'list',
  'getMetadata',
  'search',
  'createFolder',
  'rename',
  'move',
  'copy',
  'delete',
  'createShare',
  'revokeShare',
  'healthCheck',
];

const CAPABILITY_VALUES: ReadonlySet<string> = new Set(ALL_CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_VALUES.has(value);
}

export type AuthMode = 'oauth2' | 'access_key' | 'api_key';

export type ProviderCredentials =
  | {
      kind: 'oauth2';
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number | null;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
    }
  | {
      kind: 'access_key';
      accessKeyId: string;
      secretAccessKey: string;
      endpoint?: string;
      region?: string;
      forcePathStyle?: boolean;
    }
  | { kind: 'api_key'; apiKey: string; apiSecret?: string };

export interface ProviderContext {
  /** Fully-resolved, already-decrypted credential material. Never persisted. */
  credentials: ProviderCredentials;
  /** Neutral account descriptor derived from ConnectedAccount + provider config. */
  account: {
    id: string;
    userId: string;
    provider: ProviderId;
    providerAccountId: string;
    displayName?: string | null;
    config: Record<string, unknown>;
  };
  signal?: AbortSignal;
  logger: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface QuotaInfo {
  totalBytes: bigint | null;
  usedBytes: bigint;
  availableBytes: bigint | null;
  trashBytes?: bigint | null;
  raw?: Record<string, unknown>;
}

export interface RemoteFileMeta {
  remoteId: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  parentId: string | null;
  isFolder: boolean;
  createdAt?: string | null;
  modifiedAt?: string | null;
  checksum?: string | null;
  webUrl?: string | null;
}

export interface AccountInfo {
  providerAccountId: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface UploadInput {
  stream: NodeJS.ReadableStream;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  parentId: string | null;
  /** Optional opaque resume token returned by a previous uploadResumable attempt. */
  resumeToken?: string | null;
}

export interface UploadResult {
  remoteId: string;
  sizeBytes: bigint;
  resumeToken?: string | null;
}

export interface DownloadInput {
  remoteId: string;
  range?: { start: number; end?: number };
}

export interface DownloadResult {
  stream: NodeJS.ReadableStream;
  sizeBytes?: bigint | null;
  mimeType?: string | null;
  /** Byte range actually served, when `range` was requested. */
  range?: { start: number; end: number; total: number | null };
}

export interface ListInput {
  parentId: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface ListResult {
  entries: RemoteFileMeta[];
  nextCursor?: string | null;
}

export interface GetMetadataInput {
  remoteId: string;
}

export interface CreateFolderInput {
  name: string;
  parentId: string | null;
}

export interface RenameInput {
  remoteId: string;
  newName: string;
}

export interface MoveInput {
  remoteId: string;
  newParentId: string | null;
}

export interface CopyInput {
  remoteId: string;
  newParentId: string | null;
  newName?: string;
}

export interface DeleteInput {
  remoteId: string;
  permanent?: boolean;
}

export type ShareVisibility = 'public_read' | 'private';

export interface CreateShareInput {
  remoteId: string;
  visibility: ShareVisibility;
  expiresAt?: string | null;
}

export interface RevokeShareInput {
  remoteId: string;
}

export interface ShareResult {
  url: string;
  visibility: ShareVisibility;
  expiresAt?: string | null;
}

export type HealthState = 'healthy' | 'degraded' | 'unauthorized' | 'unreachable' | 'unknown';

export interface HealthResult {
  state: HealthState;
  latencyMs: number;
  message?: string | null;
  checkedAt: string;
}

export interface Page<T> {
  entries: T[];
  nextCursor?: string | null;
}

/** Opaque pagination cursor helpers shared by adapters that page by offset. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,15}$/.test(text)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'invalid pagination cursor');
  }
  const offset = Number(text);
  if (!Number.isSafeInteger(offset)) {
    throw new ProviderError('ERR_INVALID_INPUT', 'invalid pagination cursor');
  }
  return offset;
}

export interface StorageProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly authMode: AuthMode;
  readonly capabilities: ReadonlySet<Capability>;

  getCapabilities(): ReadonlySet<Capability>;

  getAccountInfo(ctx: ProviderContext): Promise<AccountInfo>;

  getQuota(ctx: ProviderContext): Promise<QuotaInfo>;

  upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult>;
  download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult>;
  list(ctx: ProviderContext, input: ListInput): Promise<ListResult>;
  getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta>;
  createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta>;
  rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta>;
  move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta>;
  copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta>;
  delete(ctx: ProviderContext, input: DeleteInput): Promise<void>;
  createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult>;
  revokeShare?(ctx: ProviderContext, input: RevokeShareInput): Promise<void>;
  healthCheck(ctx: ProviderContext): Promise<HealthResult>;
}
