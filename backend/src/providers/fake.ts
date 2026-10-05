/**
 * Deterministic in-memory StorageProvider double — see
 * docs/architecture/contracts/provider-contract.md §4.
 *
 * Used by unit tests, the Queue/Worker agent (job retries) and QA. It materialises
 * object content in memory by design (test data only) while still honouring the
 * streaming signatures, capability gating, quota accounting and the error taxonomy.
 * Latency and per-operation failures are injectable for retry/backoff tests.
 */

import { Readable } from 'node:stream';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import type {
  AccountInfo,
  AuthMode,
  Capability,
  CopyInput,
  CreateFolderInput,
  CreateShareInput,
  DeleteInput,
  DownloadInput,
  DownloadResult,
  GetMetadataInput,
  HealthResult,
  HealthState,
  ListInput,
  ListResult,
  MoveInput,
  ProviderContext,
  ProviderId,
  QuotaInfo,
  RemoteFileMeta,
  RenameInput,
  RevokeShareInput,
  ShareResult,
  StorageProvider,
  UploadInput,
  UploadResult,
} from './types.js';
import { ALL_CAPABILITIES, decodeOffsetCursor, encodeOffsetCursor } from './types.js';

export type FakeOperation =
  | 'getAccountInfo'
  | 'getQuota'
  | 'upload'
  | 'download'
  | 'list'
  | 'getMetadata'
  | 'createFolder'
  | 'rename'
  | 'move'
  | 'copy'
  | 'delete'
  | 'createShare'
  | 'revokeShare'
  | 'healthCheck';

export interface FakeFailureRule {
  operation: FakeOperation | '*';
  code?: ProviderErrorCode;
  message?: string;
  upstreamStatus?: number;
  retryable?: boolean;
  delayMs?: number;
  /** Number of matching attempts that fail. Defaults to 1; use Infinity for permanent failure. */
  times?: number;
}

export interface FakeCallRecord {
  seq: number;
  operation: FakeOperation;
  ok: boolean;
  code?: ProviderErrorCode;
}

export interface FakeQuotaOptions {
  totalBytes?: bigint | null;
  trashBytes?: bigint | null;
  usedBytes?: bigint | null;
}

export interface FakeHealthOptions {
  state?: HealthState;
  message?: string | null;
  latencyMs?: number | null;
}

export interface FakeProviderOptions {
  id?: ProviderId;
  displayName?: string;
  authMode?: AuthMode;
  capabilities?: Iterable<Capability>;
  latencyMs?: number;
  quota?: FakeQuotaOptions;
  account?: Partial<AccountInfo>;
  health?: FakeHealthOptions;
  failures?: FakeFailureRule[];
  clock?: () => Date;
}

const OP_CAPABILITY: Readonly<Record<FakeOperation, Capability>> = {
  getAccountInfo: 'getAccountInfo',
  getQuota: 'getQuota',
  upload: 'upload',
  download: 'download',
  list: 'list',
  getMetadata: 'getMetadata',
  createFolder: 'createFolder',
  rename: 'rename',
  move: 'move',
  copy: 'copy',
  delete: 'delete',
  createShare: 'createShare',
  revokeShare: 'revokeShare',
  healthCheck: 'healthCheck',
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const FOLDER_MIME_TYPE = 'inode/directory';
const FILE_MIME_TYPE = 'application/octet-stream';
const EPOCH_MS = Date.UTC(2026, 0, 1);

interface FakeNode {
  id: string;
  name: string;
  parentId: string | null;
  isFolder: boolean;
  mimeType: string;
  sizeBytes: bigint;
  content: Buffer | null;
  createdAt: string;
  modifiedAt: string;
  share: ShareResult | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new ProviderError('ERR_TIMEOUT', 'operation aborted'));
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener('abort', fail);
    const fail = () => {
      clearTimeout(timer);
      cleanup();
      reject(new ProviderError('ERR_TIMEOUT', 'operation aborted'));
    };
    if (signal?.aborted) {
      reject(new ProviderError('ERR_TIMEOUT', 'operation aborted'));
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) fail();
  });
}

export class FakeProvider implements StorageProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly authMode: AuthMode;
  readonly capabilities: ReadonlySet<Capability>;

  private readonly nodes = new Map<string, FakeNode>();
  private readonly clock: () => Date;
  private readonly defaults: {
    latencyMs: number;
    quota: FakeQuotaOptions;
    account: AccountInfo;
    health: Required<FakeHealthOptions>;
    failures: FakeFailureRule[];
  };

  private latencyMs: number;
  private quota: FakeQuotaOptions;
  private account: AccountInfo;
  private health: Required<FakeHealthOptions>;
  private failures: FakeFailureRule[];
  private calls: FakeCallRecord[] = [];
  private idSeq = 0;
  private tick = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.id = options.id ?? 'fake';
    this.displayName = options.displayName ?? 'Fake Storage';
    this.authMode = options.authMode ?? 'api_key';
    this.capabilities = new Set(options.capabilities ?? ALL_CAPABILITIES);
    this.latencyMs = options.latencyMs ?? 0;
    this.quota = { totalBytes: null, trashBytes: null, usedBytes: null, ...options.quota };
    this.account = {
      providerAccountId: 'fake-account-0001',
      email: 'fake@example.invalid',
      displayName: 'Fake Account',
      avatarUrl: null,
      ...options.account,
    };
    this.health = {
      state: options.health?.state ?? 'healthy',
      message: options.health?.message ?? null,
      latencyMs: options.health?.latencyMs ?? null,
    };
    this.failures = (options.failures ?? []).map((rule) => ({ times: 1, ...rule }));
    this.clock =
      options.clock ??
      (() => {
        const now = new Date(EPOCH_MS + this.tick);
        this.tick += 1;
        return now;
      });
    this.defaults = {
      latencyMs: this.latencyMs,
      quota: { ...this.quota },
      account: { ...this.account },
      health: { ...this.health },
      failures: this.failures.map((rule) => ({ ...rule })),
    };
  }

  getCapabilities(): ReadonlySet<Capability> {
    return this.capabilities;
  }

  getAccountInfo(ctx: ProviderContext): Promise<AccountInfo> {
    return this.#run('getAccountInfo', ctx, () => ({ ...this.account }));
  }

  getQuota(ctx: ProviderContext): Promise<QuotaInfo> {
    return this.#run('getQuota', ctx, () => {
      const totalBytes = this.quota.totalBytes ?? null;
      const usedBytes = this.quota.usedBytes ?? this.#usedBytes();
      const availableBytes = totalBytes === null ? null : totalBytes > usedBytes ? totalBytes - usedBytes : 0n;
      return {
        totalBytes,
        usedBytes,
        availableBytes,
        trashBytes: this.quota.trashBytes ?? null,
        raw: { source: 'fake' },
      };
    });
  }

  upload(ctx: ProviderContext, input: UploadInput): Promise<UploadResult> {
    return this.#run('upload', ctx, () => this.#doUpload(input));
  }

  download(ctx: ProviderContext, input: DownloadInput): Promise<DownloadResult> {
    return this.#run('download', ctx, () => this.#doDownload(input));
  }

  list(ctx: ProviderContext, input: ListInput): Promise<ListResult> {
    return this.#run('list', ctx, () => this.#doList(input));
  }

  getMetadata(ctx: ProviderContext, input: GetMetadataInput): Promise<RemoteFileMeta> {
    return this.#run('getMetadata', ctx, () => this.#meta(this.#requireNode(input.remoteId)));
  }

  createFolder(ctx: ProviderContext, input: CreateFolderInput): Promise<RemoteFileMeta> {
    return this.#run('createFolder', ctx, () => this.#doCreateFolder(input));
  }

  rename(ctx: ProviderContext, input: RenameInput): Promise<RemoteFileMeta> {
    return this.#run('rename', ctx, () => this.#doRename(input));
  }

  move(ctx: ProviderContext, input: MoveInput): Promise<RemoteFileMeta> {
    return this.#run('move', ctx, () => this.#doMove(input));
  }

  copy(ctx: ProviderContext, input: CopyInput): Promise<RemoteFileMeta> {
    return this.#run('copy', ctx, () => this.#doCopy(input));
  }

  delete(ctx: ProviderContext, input: DeleteInput): Promise<void> {
    return this.#run('delete', ctx, () => this.#doDelete(input.remoteId));
  }

  createShare(ctx: ProviderContext, input: CreateShareInput): Promise<ShareResult> {
    return this.#run('createShare', ctx, () => this.#doCreateShare(input));
  }

  revokeShare(ctx: ProviderContext, input: RevokeShareInput): Promise<void> {
    return this.#run('revokeShare', ctx, () => {
      this.#requireNode(input.remoteId).share = null;
    });
  }

  healthCheck(ctx: ProviderContext): Promise<HealthResult> {
    return this.#run('healthCheck', ctx, () => {
      const startedAt = Date.now();
      return {
        state: this.health.state,
        latencyMs: this.health.latencyMs ?? Math.max(0, Date.now() - startedAt),
        message: this.health.message ?? null,
        checkedAt: this.clock().toISOString(),
      };
    });
  }

  setLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new ProviderError('ERR_INVALID_INPUT', 'latency must be a non-negative number');
    this.latencyMs = ms;
  }

  get currentLatencyMs(): number {
    return this.latencyMs;
  }

  setQuota(quota: FakeQuotaOptions): void {
    this.quota = { ...this.quota, ...quota };
  }

  setHealth(health: FakeHealthOptions): void {
    this.health = { ...this.health, ...health };
  }

  setAccount(account: Partial<AccountInfo>): void {
    this.account = { ...this.account, ...account };
  }

  injectFailure(rule: FakeFailureRule): void {
    if (rule.operation !== '*' && !Object.prototype.hasOwnProperty.call(OP_CAPABILITY, rule.operation)) {
      throw new ProviderError('ERR_INVALID_INPUT', `unknown fake operation '${String(rule.operation)}'`);
    }
    this.failures.push({ times: 1, ...rule });
  }

  failNext(operation: FakeOperation | '*', opts: Omit<FakeFailureRule, 'operation'> = {}): void {
    this.injectFailure({ operation, ...opts });
  }

  clearFailures(): void {
    this.failures = [];
  }

  get callLog(): readonly FakeCallRecord[] {
    return this.calls;
  }

  callCount(operation?: FakeOperation): number {
    return operation ? this.calls.filter((call) => call.operation === operation).length : this.calls.length;
  }

  clearCallLog(): void {
    this.calls = [];
  }

  clearStorage(): void {
    this.nodes.clear();
    this.idSeq = 0;
  }

  reset(): void {
    this.nodes.clear();
    this.idSeq = 0;
    this.tick = 0;
    this.calls = [];
    this.latencyMs = this.defaults.latencyMs;
    this.quota = { ...this.defaults.quota };
    this.account = { ...this.defaults.account };
    this.health = { ...this.defaults.health };
    this.failures = this.defaults.failures.map((rule) => ({ ...rule }));
  }

  seedFolder(input: { name: string; parentId?: string | null }): RemoteFileMeta {
    const parentId = input.parentId ?? null;
    if (parentId !== null) this.#requireFolder(parentId);
    const name = input.name.trim();
    if (!name) throw new ProviderError('ERR_INVALID_INPUT', 'folder name is required');
    const node = this.#createNode({ name, parentId, isFolder: true, mimeType: FOLDER_MIME_TYPE, content: null, sizeBytes: 0n });
    return this.#meta(node);
  }

  seedFile(input: { name: string; parentId?: string | null; content?: string | Buffer; mimeType?: string }): RemoteFileMeta {
    const parentId = input.parentId ?? null;
    if (parentId !== null) this.#requireFolder(parentId);
    const name = input.name.trim();
    if (!name) throw new ProviderError('ERR_INVALID_INPUT', 'file name is required');
    const content = input.content === undefined ? Buffer.alloc(0) : Buffer.isBuffer(input.content) ? Buffer.from(input.content) : Buffer.from(input.content, 'utf8');
    const node = this.#createNode({
      name,
      parentId,
      isFolder: false,
      mimeType: input.mimeType ?? FILE_MIME_TYPE,
      content,
      sizeBytes: BigInt(content.byteLength),
    });
    return this.#meta(node);
  }

  getContent(remoteId: string): Buffer | null {
    return this.nodes.get(remoteId)?.content ?? null;
  }

  listSeed(): RemoteFileMeta[] {
    return [...this.nodes.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((node) => this.#meta(node));
  }

  async #run<T>(operation: FakeOperation, ctx: ProviderContext, body: () => Promise<T> | T): Promise<T> {
    if (ctx.signal?.aborted) {
      this.#log(operation, false, 'ERR_TIMEOUT');
      throw new ProviderError('ERR_TIMEOUT', `fake ${operation} aborted`);
    }
    const capability = OP_CAPABILITY[operation];
    if (!this.capabilities.has(capability)) {
      this.#log(operation, false, 'ERR_CAPABILITY_UNSUPPORTED');
      throw new ProviderError('ERR_CAPABILITY_UNSUPPORTED', `provider '${this.id}' does not declare capability '${capability}'`);
    }
    const failure = this.#takeFailure(operation);
    if (failure) {
      const code = failure.code ?? 'ERR_UPSTREAM_UNAVAILABLE';
      if (failure.delayMs) await sleep(failure.delayMs, ctx.signal);
      this.#log(operation, false, code);
      throw new ProviderError(code, failure.message ?? `fake ${operation} failure`, {
        upstreamStatus: failure.upstreamStatus,
        retryable: failure.retryable,
      });
    }
    await sleep(this.latencyMs, ctx.signal);
    try {
      const result = await body();
      this.#log(operation, true);
      return result;
    } catch (err) {
      this.#log(operation, false, ProviderError.is(err) ? err.code : 'ERR_INTERNAL');
      throw err;
    }
  }

  #takeFailure(operation: FakeOperation): FakeFailureRule | null {
    const index = this.failures.findIndex((rule) => (rule.operation === '*' || rule.operation === operation) && (rule.times ?? 1) > 0);
    if (index === -1) return null;
    const rule = this.failures[index];
    const remaining = rule.times ?? 1;
    if (Number.isFinite(remaining)) this.failures[index] = { ...rule, times: remaining - 1 };
    return rule;
  }

  #log(operation: FakeOperation, ok: boolean, code?: ProviderErrorCode): void {
    this.calls.push({ seq: this.calls.length, operation, ok, code });
  }

  #now(): string {
    return this.clock().toISOString();
  }

  #nextId(prefix: 'file' | 'folder'): string {
    this.idSeq += 1;
    return `${prefix}-${this.idSeq}`;
  }

  #usedBytes(): bigint {
    let used = 0n;
    for (const node of this.nodes.values()) {
      if (!node.isFolder && node.content) used += BigInt(node.content.byteLength);
    }
    return used;
  }

  #createNode(input: { name: string; parentId: string | null; isFolder: boolean; mimeType: string; content: Buffer | null; sizeBytes: bigint }): FakeNode {
    const now = this.#now();
    const node: FakeNode = {
      id: this.#nextId(input.isFolder ? 'folder' : 'file'),
      name: input.name,
      parentId: input.parentId,
      isFolder: input.isFolder,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      content: input.content,
      createdAt: now,
      modifiedAt: now,
      share: null,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  #requireNode(remoteId: string): FakeNode {
    const node = this.nodes.get(remoteId);
    if (!node) throw new ProviderError('ERR_NOT_FOUND', `remoteId '${remoteId}' not found`);
    return node;
  }

  #requireFolder(remoteId: string): FakeNode {
    const node = this.#requireNode(remoteId);
    if (!node.isFolder) throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${remoteId}' is not a folder`);
    return node;
  }

  #requireParent(parentId: string | null): void {
    if (parentId !== null) this.#requireFolder(parentId);
  }

  #childrenOf(parentId: string | null): FakeNode[] {
    const children = [...this.nodes.values()].filter((node) => node.parentId === parentId);
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return children;
  }

  #subtreeIds(root: FakeNode): string[] {
    const ids: string[] = [root.id];
    if (root.isFolder) {
      for (const child of this.#childrenOf(root.id)) ids.push(...this.#subtreeIds(child));
    }
    return ids;
  }

  #isDescendant(candidateId: string, ancestorId: string): boolean {
    let cursor = this.nodes.get(candidateId) ?? null;
    while (cursor) {
      if (cursor.id === ancestorId) return true;
      cursor = cursor.parentId === null ? null : this.nodes.get(cursor.parentId) ?? null;
    }
    return false;
  }

  #meta(node: FakeNode): RemoteFileMeta {
    return {
      remoteId: node.id,
      name: node.name,
      mimeType: node.mimeType,
      sizeBytes: node.sizeBytes,
      parentId: node.parentId,
      isFolder: node.isFolder,
      createdAt: node.createdAt,
      modifiedAt: node.modifiedAt,
      checksum: null,
      webUrl: node.isFolder ? null : `https://fake.invalid/o/${node.id}`,
    };
  }

  #assertRoom(additional: bigint): void {
    const totalBytes = this.quota.totalBytes ?? null;
    if (totalBytes === null) return;
    const usedBytes = this.quota.usedBytes ?? this.#usedBytes();
    if (usedBytes + additional > totalBytes) {
      throw new ProviderError('ERR_QUOTA_EXCEEDED', `quota exceeded for provider '${this.id}'`);
    }
  }

  async #doUpload(input: UploadInput): Promise<UploadResult> {
    const name = input.fileName.trim();
    if (!name) throw new ProviderError('ERR_INVALID_INPUT', 'fileName is required');
    this.#requireParent(input.parentId);
    if (input.sizeBytes > 0n) this.#assertRoom(input.sizeBytes);
    const chunks: Buffer[] = [];
    let size = 0n;
    for await (const chunk of input.stream as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buffer);
      size += BigInt(buffer.byteLength);
    }
    this.#assertRoom(size);
    const node = this.#createNode({
      name,
      parentId: input.parentId,
      isFolder: false,
      mimeType: input.mimeType || FILE_MIME_TYPE,
      content: Buffer.concat(chunks),
      sizeBytes: size,
    });
    return { remoteId: node.id, sizeBytes: size, resumeToken: null };
  }

  #doDownload(input: DownloadInput): DownloadResult {
    const node = this.#requireNode(input.remoteId);
    if (node.isFolder) throw new ProviderError('ERR_INVALID_INPUT', `remoteId '${input.remoteId}' is a folder`);
    const content = node.content ?? Buffer.alloc(0);
    const total = content.byteLength;
    if (!input.range) {
      return { stream: Readable.from([content]), sizeBytes: BigInt(total), mimeType: node.mimeType };
    }
    const { start, end } = input.range;
    if (!Number.isInteger(start) || start < 0 || total === 0 || start > total - 1) {
      throw new ProviderError('ERR_INVALID_INPUT', 'range start is outside the object');
    }
    if (end !== undefined && !Number.isInteger(end)) throw new ProviderError('ERR_INVALID_INPUT', 'range end must be an integer');
    const stop = end === undefined ? total - 1 : Math.min(end, total - 1);
    if (stop < start) throw new ProviderError('ERR_INVALID_INPUT', 'range end precedes range start');
    const slice = content.subarray(start, stop + 1);
    return {
      stream: Readable.from([slice]),
      sizeBytes: BigInt(slice.byteLength),
      mimeType: node.mimeType,
      range: { start, end: stop, total },
    };
  }

  #doList(input: ListInput): ListResult {
    this.#requireParent(input.parentId);
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) throw new ProviderError('ERR_INVALID_INPUT', 'limit must be a positive integer');
    const pageSize = Math.min(limit, MAX_PAGE_SIZE);
    const children = this.#childrenOf(input.parentId);
    const offset = input.cursor ? decodeOffsetCursor(input.cursor) : 0;
    const page = children.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      entries: page.map((node) => this.#meta(node)),
      nextCursor: nextOffset < children.length ? encodeOffsetCursor(nextOffset) : null,
    };
  }

  #doCreateFolder(input: CreateFolderInput): RemoteFileMeta {
    const name = input.name.trim();
    if (!name) throw new ProviderError('ERR_INVALID_INPUT', 'folder name is required');
    this.#requireParent(input.parentId);
    const existing = this.#childrenOf(input.parentId).find((node) => node.isFolder && node.name === name);
    if (existing) return this.#meta(existing);
    return this.#meta(this.#createNode({ name, parentId: input.parentId, isFolder: true, mimeType: FOLDER_MIME_TYPE, content: null, sizeBytes: 0n }));
  }

  #doRename(input: RenameInput): RemoteFileMeta {
    const node = this.#requireNode(input.remoteId);
    const newName = input.newName.trim();
    if (!newName) throw new ProviderError('ERR_INVALID_INPUT', 'newName is required');
    node.name = newName;
    node.modifiedAt = this.#now();
    return this.#meta(node);
  }

  #doMove(input: MoveInput): RemoteFileMeta {
    const node = this.#requireNode(input.remoteId);
    this.#assertMovable(node, input.newParentId);
    node.parentId = input.newParentId;
    node.modifiedAt = this.#now();
    return this.#meta(node);
  }

  #assertMovable(node: FakeNode, newParentId: string | null): void {
    if (newParentId === null) return;
    this.#requireFolder(newParentId);
    if (node.isFolder && (newParentId === node.id || this.#isDescendant(newParentId, node.id))) {
      throw new ProviderError('ERR_INVALID_INPUT', 'cannot move or copy a folder into itself');
    }
  }

  #doCopy(input: CopyInput): RemoteFileMeta {
    const source = this.#requireNode(input.remoteId);
    this.#assertMovable(source, input.newParentId);
    const clone = (original: FakeNode, parentId: string | null, name?: string): FakeNode => {
      const copyNode = this.#createNode({
        name: name ?? original.name,
        parentId,
        isFolder: original.isFolder,
        mimeType: original.mimeType,
        content: original.content ? Buffer.from(original.content) : null,
        sizeBytes: original.sizeBytes,
      });
      if (original.isFolder) {
        for (const child of this.#childrenOf(original.id)) clone(child, copyNode.id);
      }
      return copyNode;
    };
    return this.#meta(clone(source, input.newParentId, input.newName?.trim() || undefined));
  }

  #doDelete(remoteId: string): void {
    const node = this.#requireNode(remoteId);
    for (const id of this.#subtreeIds(node)) this.nodes.delete(id);
  }

  #doCreateShare(input: CreateShareInput): ShareResult {
    const node = this.#requireNode(input.remoteId);
    const share: ShareResult = {
      url: `https://fake.invalid/share/${node.id}`,
      visibility: input.visibility,
      expiresAt: input.expiresAt ?? null,
    };
    node.share = share;
    return { ...share };
  }
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  return new FakeProvider(options);
}
